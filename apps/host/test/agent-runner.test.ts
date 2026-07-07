import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// chatStore() is a lazily-initialized singleton keyed off CHATS_DIR; point it at a
// throwaway dir before anything in this test file (or its imports) can call it.
process.env.CHATS_DIR = mkdtempSync(join(tmpdir(), "agent-runner-chats-"));

import { buildPiRuntime, ChatManager, KeyedQueue, sharedMcpBridge } from "../src/core/agent-runner.ts";
import { Session } from "../src/core/session.ts";
import { defaultPolicy } from "../src/core/tool-policy.ts";
import { chatStore } from "../src/core/chat-store.ts";
import { isRunning } from "../src/core/running-chats.ts";

const echo = fileURLToPath(new URL("./fixtures/echo-mcp-server.mts", import.meta.url));

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
  await cm.runTurn(missingChatId, "hello");
  assert.equal(chatStore().exists(missingChatId), false);
  assert.deepEqual(chatStore().getMessages(missingChatId), []);
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
  assert.equal(isRunning(chat.id), false, "must not be running before the turn starts");

  const turnPromise = cm.runTurn(chat.id, "Say hello in one short sentence.");
  await new Promise((r) => setTimeout(r, 50)); // let doRunTurn reach its synchronous markRunning() call
  assert.equal(isRunning(chat.id), true, "must be marked running while the turn is in flight");

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
    assistantBuffer: "", aborted: false, starts: new Map(), toolInputs: new Map(),
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
