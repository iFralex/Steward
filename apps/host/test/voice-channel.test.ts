import { test } from "node:test";
import assert from "node:assert/strict";
import { loadVoiceChannelConfig } from "../src/config.ts";
import { ringbackCallPrompt, VoiceBusyError, VoiceCallCoordinator } from "../src/core/voice-channel.ts";

test("voice config is disabled unless explicitly selected", () => {
  assert.deepEqual(loadVoiceChannelConfig({}), { transport: "disabled" });
});

test("ringback config keeps a stable transport-neutral launcher boundary", () => {
  assert.deepEqual(loadVoiceChannelConfig({
    STEWARD_VOICE_TRANSPORT: "ringback",
    STEWARD_RINGBACK_LAUNCHER: "/opt/steward/ringback/run_voice_mcp.sh",
    STEWARD_VOICE_OPENING_LINE: "Pronto?",
  }), {
    transport: "ringback",
    launcher: "/opt/steward/ringback/run_voice_mcp.sh",
    openingLine: "Pronto?",
    preflightTimeoutMs: 10_000,
  });
});

test("StreamCore already has a config shape without pretending it is implemented", () => {
  const config = loadVoiceChannelConfig({ STEWARD_VOICE_TRANSPORT: "streamcore" });
  assert.equal(config.transport, "streamcore");
  assert.equal(config.baseUrl, "http://127.0.0.1:8080");

  const coordinator = new VoiceCallCoordinator({ voice: config } as any);
  assert.deepEqual({ ...coordinator.status(), updatedAt: 0 }, {
    enabled: false,
    transport: "streamcore",
    state: "disabled",
    updatedAt: 0,
    detail: "StreamCore transport is reserved but not implemented yet.",
  });
});

test("Ringback voice prompt enforces the phone loop and approval boundary", () => {
  const prompt = ringbackCallPrompt("Ciao, sono Steward.");
  assert.match(prompt, /mcp__voice__call_start/);
  assert.match(prompt, /mcp__voice__converse/);
  assert.match(prompt, /mcp__voice__call_end/);
  assert.match(prompt, /non sono autorizzabili a voce/i);
  assert.match(prompt, /non riprovare/i);
  assert.match(prompt, /Ciao, sono Steward\./);
});

function fakeConfig() {
  return {
    voice: {
      transport: "ringback",
      launcher: "/tmp/ringback",
      openingLine: "Pronto?",
      preflightTimeoutMs: 1_000,
    },
    mcpServers: {},
    gateway: {},
    policy: { default: "deny", rules: {} },
    approvalTimeoutMs: 1_000,
  } as any;
}

function fakeBridge(status = '{"ready":true,"phase":"idle"}') {
  return {
    tools: ["call_start", "call_status", "call_end"].map((name) => ({ name: `mcp__voice__${name}` })),
    callTool: async () => [{ type: "text", text: status }],
    close: async () => {},
  } as any;
}

test("preflight runs before chat creation and duplicate request ids are idempotent", async () => {
  let emit: ((event: any) => void) | undefined;
  let finishTurn: ((result: any) => void) | undefined;
  const turn = new Promise<any>((resolve) => { finishTurn = resolve; });
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => fakeBridge(),
    createChat: () => ({ id: "voice-chat" }),
    createRunner: (handler) => {
      emit = handler;
      return { runTurn: async () => turn, abort: async () => {} };
    },
    audit: (() => {}) as any,
    usage: () => {},
    now: () => 1234,
    sleep: async () => {},
  });

  const first = await coordinator.start(undefined, "request-1");
  assert.equal(first.chatId, "voice-chat");
  assert.equal(first.requestId, "request-1");
  const duplicate = await coordinator.start(undefined, "request-1");
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(() => coordinator.start(undefined, "request-2"), VoiceBusyError);

  emit?.({ type: "tool_call", tool: "mcp__voice__call_start" });
  assert.equal(coordinator.status().state, "ringing");
  emit?.({ type: "tool_result", tool: "mcp__voice__call_start", ok: true, output: 'User replied: "ciao"' });
  assert.equal(coordinator.status().state, "processing");
  finishTurn?.({ ok: true, messageId: null, text: "done" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.status().state, "idle");
  assert.equal(coordinator.status().lastCall?.ok, true);
});

test("a resolved TurnResult with ok false marks the call as failed", async () => {
  let finishedError: Error | undefined;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), (_chatId, error) => { finishedError = error; }, {
    bridge: async () => fakeBridge(),
    createChat: () => ({ id: "failed-chat" }),
    createRunner: () => ({
      runTurn: async () => ({ ok: false, error: "agent unavailable", aborted: false, messageId: null, text: "" }),
      abort: async () => {},
    }),
    audit: (() => {}) as any,
    usage: () => {},
    sleep: async () => {},
  });

  await coordinator.start(undefined, "request-failure");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finishedError?.message, "agent unavailable");
  assert.equal(coordinator.status().state, "idle");
  assert.equal(coordinator.status().lastCall?.ok, false);
  assert.equal(coordinator.status().retryable, true);
});

test("preflight retries once but never creates a chat when Ringback stays unhealthy", async () => {
  let attempts = 0;
  let chats = 0;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => {
      attempts += 1;
      throw new Error("MCP offline");
    },
    createChat: () => { chats += 1; return { id: "must-not-exist" }; },
    audit: (() => {}) as any,
    usage: () => {},
    sleep: async () => {},
  });
  await assert.rejects(() => coordinator.start(undefined, "preflight-failure"), /MCP offline/);
  assert.equal(attempts, 2);
  assert.equal(chats, 0);
  assert.equal(coordinator.status().state, "failed");
  assert.equal(coordinator.status().retryable, true);
});

test("preflight rejects Ringback's machine-readable ready false result", async () => {
  let attempts = 0;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => {
      attempts += 1;
      return fakeBridge('{"ready":false,"phase":"failed","error":"pjsua init failed"}');
    },
    createChat: () => ({ id: "must-not-exist" }),
    audit: (() => {}) as any,
    usage: () => {},
    sleep: async () => {},
  });
  await assert.rejects(() => coordinator.start(undefined, "unhealthy-engine"), /pjsua init failed/);
  assert.equal(attempts, 2);
  assert.equal(coordinator.status().state, "failed");
});

test("structured SIP failures reach status, Usage, Audit, and completion callback", async () => {
  let emit: ((event: any) => void) | undefined;
  let finishTurn: ((result: any) => void) | undefined;
  let finishedError: Error | undefined;
  const usage: any[] = [];
  const audit: any[] = [];
  const turn = new Promise<any>((resolve) => { finishTurn = resolve; });
  let now = 1_000;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), (_chatId, error) => { finishedError = error; }, {
    bridge: async () => fakeBridge(),
    createChat: () => ({ id: "sip-failure-chat" }),
    createRunner: (handler) => {
      emit = handler;
      return { runTurn: async () => turn, abort: async () => {} };
    },
    audit: ((event: any) => audit.push(event)) as any,
    usage: (record) => usage.push(record),
    now: () => now,
    sleep: async () => {},
  });
  await coordinator.start(undefined, "sip-failure");
  now = 5_000;
  emit?.({
    type: "tool_result", tool: "mcp__voice__call_start", ok: false,
    output: '[CALL FAILED] {"code":"unreachable","message":"Phone unreachable","retryable":true,"sipStatus":480,"sipReason":"Temporarily Unavailable","dialDurationMs":3900}',
  });
  finishTurn?.({ ok: true, messageId: null, text: "done" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(finishedError?.message, "Phone unreachable");
  assert.equal(coordinator.status().lastCall?.failureCode, "unreachable");
  assert.equal(coordinator.status().lastCall?.sipStatus, 480);
  assert.equal(coordinator.status().lastCall?.durationMs, 4_000);
  assert.deepEqual(usage[0], {
    ts: 5_000, sessionId: "sip-failure-chat", transport: "ringback", outcome: "unreachable",
    failureCode: "unreachable", sipStatus: 480, durationMs: 4_000, ok: false,
  });
  const failed = audit.find((event) => event.eventType === "voice.call_failed");
  assert.equal(failed.durationMs, 4_000);
  assert.equal(failed.payload.diagnostic.sipStatus, 480);
});
