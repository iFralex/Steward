import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = mkdtempSync(join(tmpdir(), "watch-agent-delivery-"));
process.env.CHATS_DIR = join(testRoot, "chats");
process.env.AUDIT_DIR = join(testRoot, "audit");
process.env.USAGE_DIR = join(testRoot, "usage");

import { WatchEngine, WatchStore, type DomainEvent, type WatchAdapter } from "@steward/watch-engine";
import { chatStore } from "../src/core/chat-store.ts";
import { pollAndDeliverWatchEvents } from "../src/core/watch-notification-service.ts";
import { PushRegistry } from "../src/core/push.ts";

class Adapter implements WatchAdapter {
  readonly source = "fake";
  step = 0;
  async snapshot() { return { step: this.step }; }
  defaultExpiry() { return Date.now() + 60_000; }
  isTerminal() { return false; }
  events(previous: unknown, current: unknown): DomainEvent[] {
    const before = (previous as { step: number }).step;
    const after = (current as { step: number }).step;
    return before === after ? [] : [{
      type: "fake.arrived", key: `step:${after}`, timestamp: Date.now(),
      data: { positionRelativeToDestination: -1 }, currentState: current,
      fallbackText: "Siamo alla fermata precedente.",
    }];
  }
}

async function fixture(voice = false) {
  const store = WatchStore.open(join(mkdtempSync(join(testRoot, "watch-")), "watches.db"));
  const adapter = new Adapter();
  const engine = new WatchEngine(store).register(adapter);
  const chat = chatStore().createChat("Viaggio");
  await engine.create({
    source: "fake", resourceRef: "train-ref", chatId: chat.id,
    instruction: "Chiamami alla fermata precedente",
    rules: [{ id: "before", event: "fake.arrived", once: true,
      ...(voice ? { grants: [{ tool: "mcp__voice__call_start" as const }] } : {}) }],
  });
  adapter.step = 1;
  return { engine, store, chat };
}

test("an authorized event invokes one conversational voice turn in the originating chat", async () => {
  const fx = await fixture(true);
  let calls = 0;
  let seenChat = "";
  let seenPrompt = "";
  await pollAndDeliverWatchEvents({
    engine: fx.engine,
    push: new PushRegistry(join(testRoot, "voice-push.json"), async () => {}),
    runAgentTurn: async () => { throw new Error("ordinary agent path should not run"); },
    runVoiceTurn: async (chatId, prompt) => {
      calls += 1; seenChat = chatId; seenPrompt = prompt;
      return { chatId, requestId: "event", startedAt: 1, finishedAt: 2, ok: true, durationMs: 1 };
    },
  });

  assert.equal(calls, 1);
  assert.equal(seenChat, fx.chat.id);
  assert.match(seenPrompt, /train-ref/);
  assert.match(seenPrompt, /call_start/);
  assert.equal(fx.store.pending().length, 0);
  await pollAndDeliverWatchEvents({
    engine: fx.engine,
    push: new PushRegistry(join(testRoot, "voice-push.json"), async () => {}),
    runAgentTurn: async () => { throw new Error("unexpected"); },
    runVoiceTurn: async () => { calls += 1; throw new Error("unexpected redial"); },
  });
  assert.equal(calls, 1);
  fx.store.close();
});

test("a failed voice event falls back to push and never redials on delivery retry", async () => {
  const fx = await fixture(true);
  let voiceCalls = 0;
  let pushAttempts = 0;
  const push = new PushRegistry(join(testRoot, "fallback-push.json"), async () => {
    pushAttempts += 1;
    if (pushAttempts === 1) throw Object.assign(new Error("offline"), { statusCode: 503 });
  });
  push.subscribe({ endpoint: "https://push.test/device", keys: { p256dh: "p", auth: "a" } });
  const args = {
    engine: fx.engine,
    push,
    runAgentTurn: async () => { throw new Error("unexpected ordinary turn"); },
    runVoiceTurn: async (chatId: string) => {
      voiceCalls += 1;
      return { chatId, requestId: "event", startedAt: 1, finishedAt: 2, ok: false, error: "No answer", durationMs: 1 };
    },
  };

  await pollAndDeliverWatchEvents(args);
  assert.equal(voiceCalls, 1);
  assert.equal(fx.store.pending().length, 1);
  assert.equal(fx.store.pending()[0].notificationText, "Siamo alla fermata precedente.");

  await pollAndDeliverWatchEvents(args);
  assert.equal(voiceCalls, 1, "cached fallback delivery must not redial");
  assert.equal(pushAttempts, 2);
  assert.equal(fx.store.pending().length, 0);
  fx.store.close();
});

test("a read-only watch resumes the same chat and pushes the agent response", async () => {
  const fx = await fixture();
  let seenChat = "";
  await pollAndDeliverWatchEvents({
    engine: fx.engine,
    push: new PushRegistry(join(testRoot, "agent-push.json"), async () => {}),
    runAgentTurn: async (chatId, prompt) => {
      seenChat = chatId;
      assert.match(prompt, /stessa chat/i);
      return { ok: true, messageId: "m1", text: "Il treno è alla fermata precedente." };
    },
    runVoiceTurn: async () => { throw new Error("voice must not run without authorization"); },
  });
  assert.equal(seenChat, fx.chat.id);
  assert.equal(fx.store.pending().length, 0);
  fx.store.close();
});
