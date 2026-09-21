import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// chatStore() is a lazily-initialized singleton keyed off CHATS_DIR; point it at a
// throwaway dir before anything in this test file (or its imports) can call it.
process.env.CHATS_DIR = mkdtempSync(join(tmpdir(), "agent-runner-chats-"));

import { buildPiRuntime, ChatManager, KeyedQueue, sharedMcpBridge, toolExecutionSucceeded } from "../src/core/agent-runner.ts";
import { Session } from "../src/core/session.ts";
import { defaultPolicy } from "../src/core/tool-policy.ts";
import { chatStore } from "../src/core/chat-store.ts";
import { isRunning } from "../src/core/running-chats.ts";

const echo = fileURLToPath(new URL("./fixtures/echo-mcp-server.mts", import.meta.url));

test("blocked gate results are failures for Usage and Audit", () => {
  assert.equal(toolExecutionSucceeded({ details: { stewardOutcome: "blocked" } }, false, null), false);
  assert.equal(toolExecutionSucceeded({ details: {} }, false, null), true);
  assert.equal(toolExecutionSucceeded({}, true, null), false);
});

test("KeyedQueue serializes same-key work and parallelizes different keys", async () => {
  const q = new KeyedQueue();
  const order: string[] = [];
  const slow = q.run("a", async () => { await new Promise((r) => setTimeout(r, 30)); order.push("a1"); });
  const second = q.run("a", async () => { order.push("a2"); });
  const other = q.run("b", async () => { order.push("b1"); });
  await Promise.all([slow, second, other]);
  assert.deepEqual(order.filter((x) => x.startsWith("a")), ["a1", "a2"]);
  assert.equal(order[0], "b1"); // b didn't wait for a
});

test("buildPiRuntime registers gate-wrapped bridged tools and resolves the model", async () => {
  const session = new Session(() => {}, 1000);
  const runtime = await buildPiRuntime(
    {
      port: 0, systemPrompt: "test", policy: defaultPolicy, approvalTimeoutMs: 1000,
      gateway: { baseUrl: "http://127.0.0.1:4000/v1", tier: "tier-5", apiKey: "sk-local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      mcpServers: { echo: { command: process.execPath, args: ["--import", "tsx", echo] } },
    } as any,
    session,
  );
  try {
    assert.ok(runtime.session.getActiveToolNames().includes("mcp__echo__echo"));
  } finally {
    await runtime.close();
  }
});

test("sharedMcpBridge memoizes: repeated calls return the identical bridge instance", async () => {
  // Empty specs make buildMcpBridge's connector loop a no-op (no child process
  // spawned), so this exercises the process-wide memoization in sharedMcpBridge
  // without starting any real MCP connector.
  const first = sharedMcpBridge({});
  const second = sharedMcpBridge({});
  assert.equal(first, second, "second call must return the exact same in-flight promise");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, "resolved bridge instance must be the same object across calls");
  assert.deepEqual(a.tools, [], "empty specs produce no tools and spawn no connectors");
});

test("doRunTurn does not resurrect a deleted/nonexistent chat", async () => {
  const session = new Session(() => {}, 1000);
  // Config is never touched: the missing-chat guard returns before ensureBridge
  // (and thus before the gateway/MCP servers it names) is ever invoked.
  const cm = new ChatManager(
    {
      port: 0, systemPrompt: "test", policy: defaultPolicy, approvalTimeoutMs: 1000,
      gateway: { baseUrl: "http://127.0.0.1:1/v1", tier: "tier-5", apiKey: "sk-local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      mcpServers: {},
    } as any,
    session,
    () => {},
  );
  const missingChatId = "does-not-exist-chat-id";
  const result = await cm.runTurn(missingChatId, "hello");
  assert.deepEqual(result, {
    ok: false, error: `Chat not found: ${missingChatId}`, aborted: false, messageId: null, text: "",
  });
  assert.equal(chatStore().exists(missingChatId), false);
  assert.deepEqual(chatStore().getMessages(missingChatId), []);
});

test("runTurn returns the persisted assistant message instead of requiring transcript inspection", async () => {
  const session = new Session(() => {}, 1000);
  const cm = new ChatManager(
    {
      port: 0, systemPrompt: "test", policy: defaultPolicy, approvalTimeoutMs: 1000,
      gateway: { baseUrl: "http://127.0.0.1:1/v1", tier: "tier-5", apiKey: "sk-local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      mcpServers: {},
    } as any,
    session,
    () => {},
  );
  const chat = chatStore().createChat("structured result");
  const runtime = {
    chatId: chat.id,
    session: {
      prompt: async () => { runtime.assistantBuffer = "Risposta affidabile."; },
      getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    },
    unsub: () => {}, lastCostUsd: 0,
    lastTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    assistantBuffer: "", aborted: false, starts: new Map(), toolInputs: new Map(), turnAssistantMessages: [],
  };
  (cm as any).ensureChat = async () => runtime;

  const result = await cm.runTurn(chat.id, "ciao");

  assert.equal(result.ok, true);
  assert.equal(result.text, "Risposta affidabile.");
  assert.equal(result.messageId, chatStore().getMessages(chat.id).at(-1)?.id);
});

test("runAutomaticTurn continues the session without exposing its control prompt as a user message", async () => {
  const session = new Session(() => {}, 1000);
  const cm = new ChatManager(
    {
      port: 0, systemPrompt: "test", policy: defaultPolicy, approvalTimeoutMs: 1000,
      gateway: { baseUrl: "http://127.0.0.1:1/v1", tier: "tier-5", apiKey: "sk-local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      mcpServers: {},
    } as any,
    session,
    () => {},
  );
  const chat = chatStore().createChat("automatic continuation");
  const runtime = {
    chatId: chat.id,
    session: {
      prompt: async () => { runtime.assistantBuffer = "Il treno è alla fermata precedente."; },
      getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    },
    unsub: () => {}, lastCostUsd: 0,
    lastTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    assistantBuffer: "", aborted: false, starts: new Map(), toolInputs: new Map(), turnAssistantMessages: [],
  };
  (cm as any).ensureChat = async () => runtime;

  const result = await cm.runAutomaticTurn(chat.id, "[structured automatic event]");

  assert.equal(result.ok, true);
  assert.deepEqual(chatStore().getMessages(chat.id).map((message) => message.role), ["assistant"]);
  assert.equal(chatStore().getMessages(chat.id)[0].text, "Il treno è alla fermata precedente.");
});

test("a completed turn invalidates another channel's stale session for the same chat", async () => {
  const config = {
    port: 0, systemPrompt: "test", policy: defaultPolicy, approvalTimeoutMs: 1000,
    gateway: { baseUrl: "http://127.0.0.1:1/v1", tier: "tier-5", apiKey: "sk-local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    mcpServers: {},
  } as any;
  const owner = new ChatManager(config, new Session(() => {}, 1000), () => {});
  const peer = new ChatManager(config, new Session(() => {}, 1000), () => {});
  const chat = chatStore().createChat("cross-channel continuation");
  const ownerRuntime = {
    chatId: chat.id,
    session: {
      prompt: async () => { ownerRuntime.assistantBuffer = "Aggiornamento automatico"; },
      getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    },
    unsub: () => {}, lastCostUsd: 0,
    lastTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    assistantBuffer: "", aborted: false, starts: new Map(), toolInputs: new Map(), turnAssistantMessages: [],
  };
  let disposed = false;
  const peerRuntime = {
    chatId: chat.id,
    session: { abort: async () => {}, dispose: () => { disposed = true; } },
    unsub: () => {}, aborted: false,
  };
  (owner as any).ensureChat = async () => ownerRuntime;
  (peer as any).chats.set(chat.id, peerRuntime);

  await owner.runAutomaticTurn(chat.id, "event");

  assert.equal(disposed, true);
  assert.equal((peer as any).chats.has(chat.id), false);
});

test("runTurn resolves with a structured failure when the agent errors", async () => {
  const session = new Session(() => {}, 1000);
  const cm = new ChatManager(
    {
      port: 0, systemPrompt: "test", policy: defaultPolicy, approvalTimeoutMs: 1000,
      gateway: { baseUrl: "http://127.0.0.1:1/v1", tier: "tier-5", apiKey: "sk-local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      mcpServers: {},
    } as any,
    session,
    () => {},
  );
  const chat = chatStore().createChat("structured error");
  const runtime = {
    chatId: chat.id,
    session: {
      prompt: async () => { throw new Error("gateway unavailable"); },
      getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    },
    unsub: () => {}, lastCostUsd: 0,
    lastTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    assistantBuffer: "", aborted: false, starts: new Map(), toolInputs: new Map(), turnAssistantMessages: [],
  };
  (cm as any).ensureChat = async () => runtime;

  const result = await cm.runTurn(chat.id, "ciao");

  assert.deepEqual(result, {
    ok: false, error: "gateway unavailable", aborted: false, messageId: null, text: "",
  });
});

test("doRunTurn marks the chat running for the shared running-chats registry while in flight, and idle once it finishes", async () => {
  const session = new Session(() => {}, 1000);
  const cm = new ChatManager(
    {
      port: 0, systemPrompt: "You are a test assistant. Reply with one short sentence. Do not use any tools.", policy: defaultPolicy, approvalTimeoutMs: 1000,
      gateway: { baseUrl: "http://127.0.0.1:4000/v1", tier: "tier-1", apiKey: "sk-local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      mcpServers: {},
    } as any,
    session,
    () => {},
  );
  const chat = chatStore().createChat("running-chats test");
  let finishPrompt!: () => void;
  const promptBlocked = new Promise<void>((resolve) => { finishPrompt = resolve; });
  const runtime = {
    chatId: chat.id,
    session: {
      prompt: async () => promptBlocked,
      getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    },
    unsub: () => {}, lastCostUsd: 0,
    lastTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    assistantBuffer: "", aborted: false, starts: new Map(), toolInputs: new Map(), turnAssistantMessages: [],
  };
  (cm as any).ensureChat = async () => runtime;
  assert.equal(isRunning(chat.id), false, "must not be running before the turn starts");

  const turnPromise = cm.runTurn(chat.id, "Say hello in one short sentence.");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isRunning(chat.id), true, "must be marked running while the turn is in flight");

  finishPrompt();
  await turnPromise;
  assert.equal(isRunning(chat.id), false, "must be marked idle once the turn finishes");
});

test("onPiEvent persists assistant text interleaved between tool calls, not merged at the end", () => {
  const session = new Session(() => {}, 1000);
  const cm = new ChatManager(
    {
      port: 0, systemPrompt: "test", policy: defaultPolicy, approvalTimeoutMs: 1000,
      gateway: { baseUrl: "http://127.0.0.1:1/v1", tier: "tier-5", apiKey: "sk-local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      mcpServers: {},
    } as any,
    session,
    () => {},
  );
  const chat = chatStore().createChat("interleaved test");
  const runtime = {
    chatId: chat.id, session: {} as any, unsub: () => {},
    lastCostUsd: 0, lastTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    assistantBuffer: "", aborted: false, starts: new Map(), toolInputs: new Map(), turnAssistantMessages: [],
  };
  const onPiEvent = (cm as unknown as { onPiEvent: (r: typeof runtime, e: unknown) => void }).onPiEvent.bind(cm);

  onPiEvent(runtime, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "text1" } });
  onPiEvent(runtime, { type: "tool_execution_start", toolCallId: "t1", toolName: "toolA", args: {} });
  onPiEvent(runtime, { type: "tool_execution_end", toolCallId: "t1", toolName: "toolA", result: "ok", isError: false });
  onPiEvent(runtime, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "text2" } });
  onPiEvent(runtime, { type: "tool_execution_start", toolCallId: "t2", toolName: "toolB", args: {} });
  onPiEvent(runtime, { type: "tool_execution_end", toolCallId: "t2", toolName: "toolB", result: "ok", isError: false });

  const messages = chatStore().getMessages(chat.id);
  assert.deepEqual(messages.map((m) => m.role), ["assistant", "tool", "assistant", "tool"]);
  assert.equal(messages[0].text, "text1");
  assert.equal(messages[2].text, "text2");
});
