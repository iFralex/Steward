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
import { VoiceBusyError } from "../src/core/voice-channel.ts";
import { PushRegistry } from "../src/core/push.ts";
import { TimeWatchAdapter } from "../src/core/time-watch-adapter.ts";

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

async function fixture(voice = false, voiceFallback = false) {
  const dbPath = join(mkdtempSync(join(testRoot, "watch-")), "watches.db");
  const store = WatchStore.open(dbPath);
  const adapter = new Adapter();
  const engine = new WatchEngine(store).register(adapter);
  const chat = chatStore().createChat("Viaggio");
  await engine.create({
    source: "fake", resourceRef: "train-ref", chatId: chat.id,
    instruction: "Chiamami alla fermata precedente",
    rules: [{ id: "before", event: "fake.arrived", once: true,
      ...(voice ? { grants: [{ tool: "mcp__voice__call_start" as const }] } : {}),
      ...(voiceFallback ? { voiceFallback: "push" as const } : {}) }],
  });
  adapter.step = 1;
  return { engine, store, chat, adapter, dbPath };
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
  const fx = await fixture(true, true);
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

test("a busy voice channel leaves the event pending across restart and calls when free", async () => {
  const fx = await fixture(true);
  let busy = true;
  let calls = 0;
  let pushes = 0;
  const push = new PushRegistry(join(testRoot, "busy-push.json"), async () => { pushes += 1; });
  push.subscribe({ endpoint: "https://push.test/busy", keys: { p256dh: "p", auth: "a" } });
  const runVoiceTurn = async (chatId: string) => {
    calls += 1;
    return { chatId, requestId: "busy-event", startedAt: 1, finishedAt: 2, ok: true, durationMs: 1 };
  };
  await pollAndDeliverWatchEvents({
    engine: fx.engine, push, isVoiceBusy: () => busy,
    runAgentTurn: async () => { throw new Error("unexpected agent turn"); }, runVoiceTurn,
  });
  assert.equal(calls, 0);
  assert.equal(pushes, 0);
  assert.equal(fx.store.pending().length, 1);
  assert.equal(fx.store.pending()[0].attempts, 0);
  assert.equal(fx.store.pending()[0].notificationText, undefined);
  fx.store.close();

  const reopened = WatchStore.open(fx.dbPath);
  const restartedEngine = new WatchEngine(reopened).register(fx.adapter);
  busy = false;
  await pollAndDeliverWatchEvents({
    engine: restartedEngine, push, isVoiceBusy: () => busy,
    runAgentTurn: async () => { throw new Error("unexpected agent turn"); }, runVoiceTurn,
  });
  assert.equal(calls, 1);
  assert.equal(pushes, 0);
  assert.equal(reopened.pending().length, 0);
  reopened.close();
});

test("a late busy race also defers instead of sending fallback push", async () => {
  const fx = await fixture(true, true);
  let calls = 0;
  let pushes = 0;
  const push = new PushRegistry(join(testRoot, "late-busy-push.json"), async () => { pushes += 1; });
  push.subscribe({ endpoint: "https://push.test/late-busy", keys: { p256dh: "p", auth: "a" } });
  const args = {
    engine: fx.engine, push, isVoiceBusy: () => false,
    runAgentTurn: async () => { throw new Error("unexpected agent turn"); },
    runVoiceTurn: async (chatId: string) => {
      calls += 1;
      if (calls === 1) throw new VoiceBusyError("Already calling");
      return { chatId, requestId: "late-busy", startedAt: 1, finishedAt: 2, ok: true, durationMs: 1 };
    },
  };
  await pollAndDeliverWatchEvents(args);
  assert.equal(fx.store.pending().length, 1);
  assert.equal(fx.store.pending()[0].notificationText, undefined);
  assert.equal(pushes, 0);
  await pollAndDeliverWatchEvents(args);
  assert.equal(calls, 2);
  assert.equal(fx.store.pending().length, 0);
  assert.equal(pushes, 0);
  fx.store.close();
});

test("a call-only watch records a real failure without sending another channel", async () => {
  const fx = await fixture(true);
  let pushes = 0;
  const push = new PushRegistry(join(testRoot, "only-call-push.json"), async () => { pushes += 1; });
  push.subscribe({ endpoint: "https://push.test/only-call", keys: { p256dh: "p", auth: "a" } });
  await pollAndDeliverWatchEvents({
    engine: fx.engine, push,
    runAgentTurn: async () => { throw new Error("unexpected agent turn"); },
    runVoiceTurn: async (chatId) => ({ chatId, requestId: "failed", startedAt: 1, finishedAt: 2,
      ok: false, error: "No answer", failureCode: "no_answer", durationMs: 1 }),
  });
  assert.equal(pushes, 0);
  assert.equal(fx.store.pending().length, 0);
  const status = fx.store.raw.prepare("SELECT status FROM watch_events LIMIT 1").get() as { status: string };
  assert.equal(status.status, "failed");
  fx.store.close();
});

test("a matched call-only rule vetoes fallback push from another rule", async () => {
  const fx = await fixture(true, true);
  const parent = fx.store.get(fx.store.active()[0].id);
  assert.ok(parent);
  const rules = [...parent.rules, { id: "also-call", event: "fake.arrived", once: true,
    grants: [{ tool: "mcp__voice__call_start" as const }] }];
  fx.store.raw.prepare("UPDATE watches SET rules=? WHERE id=?").run(JSON.stringify(rules), parent.id);
  let pushes = 0;
  const push = new PushRegistry(join(testRoot, "mixed-rules-push.json"), async () => { pushes += 1; });
  push.subscribe({ endpoint: "https://push.test/mixed", keys: { p256dh: "p", auth: "a" } });
  await pollAndDeliverWatchEvents({
    engine: fx.engine, push,
    runAgentTurn: async () => { throw new Error("unexpected agent turn"); },
    runVoiceTurn: async (chatId) => ({ chatId, requestId: "mixed", startedAt: 1, finishedAt: 2,
      ok: false, error: "Call failed", durationMs: 1 }),
  });
  assert.equal(pushes, 0);
  fx.store.close();
});

test("a claimed call is never redialed after restart", async () => {
  const fx = await fixture(true, true);
  await fx.engine.poll();
  const pending = fx.store.pending()[0];
  assert.ok(pending);
  assert.equal(fx.store.claimAction(pending.id, "before", "mcp__voice__call_start"), true);
  fx.store.close();

  const reopened = WatchStore.open(fx.dbPath);
  const engine = new WatchEngine(reopened).register(fx.adapter);
  let pushes = 0;
  const push = new PushRegistry(join(testRoot, "claimed-call-push.json"), async () => { pushes += 1; });
  push.subscribe({ endpoint: "https://push.test/claimed", keys: { p256dh: "p", auth: "a" } });
  await pollAndDeliverWatchEvents({
    engine, push,
    runAgentTurn: async () => { throw new Error("unexpected agent turn"); },
    runVoiceTurn: async () => { throw new Error("claimed call must not redial"); },
  });
  assert.equal(pushes, 1);
  assert.equal(reopened.pending().length, 0);
  reopened.close();
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

test("an unanswered call creates a bounded time watcher and an answered retry stops the chain", async () => {
  const store = WatchStore.open(join(mkdtempSync(join(testRoot, "continuation-")), "watches.db"));
  const adapter = new Adapter();
  let clock = Date.now();
  const engine = new WatchEngine(store).register(adapter).register(new TimeWatchAdapter(() => clock));
  const chat = chatStore().createChat("Richiamo");
  await engine.create({
    source: "fake", resourceRef: "train-ref", chatId: chat.id, expiresAt: Date.now() + 10 * 60_000,
    instruction: "Chiamami ogni minuto finché rispondo",
    rules: [{ id: "call", event: "fake.arrived", once: true,
      voiceFallback: "push",
      grants: [{ tool: "mcp__voice__call_start" }],
      continuation: { outcomes: ["not_answered"], afterMinutes: 1, maxAttempts: 3 } }],
  });
  adapter.step = 1;
  let calls = 0;
  const args = {
    engine,
    push: new PushRegistry(join(testRoot, "continuation-push.json"), async () => {}),
    runAgentTurn: async () => { throw new Error("unexpected ordinary turn"); },
    runVoiceTurn: async (chatId: string) => {
      calls += 1;
      return calls === 1
        ? { chatId, requestId: "first", startedAt: 1, finishedAt: 2, ok: false, failureCode: "no_answer", error: "No answer", durationMs: 1 }
        : { chatId, requestId: "second", startedAt: 3, finishedAt: 4, ok: true, durationMs: 1 };
    },
  };

  await pollAndDeliverWatchEvents(args);
  const child = store.active().find((watch) => watch.source === "time");
  assert.ok(child);
  assert.equal(child.rules[0].continuation?.attempt, 2);
  assert.deepEqual(child.rules[0].grants, [{ tool: "mcp__voice__call_start" }]);
  assert.equal(child.rules[0].voiceFallback, "push");

  clock = (child.snapshot as { targetTimeMs: number }).targetTimeMs + 1;
  await pollAndDeliverWatchEvents(args);
  assert.equal(calls, 2);
  assert.equal(store.active().filter((watch) => watch.source === "time").length, 0);
  store.close();
});
