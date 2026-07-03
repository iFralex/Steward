import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// chatStore() is a lazily-initialized singleton keyed off CHATS_DIR; point it at a
// throwaway dir before anything in this test file (or its imports) can call it.
process.env.CHATS_DIR = mkdtempSync(join(tmpdir(), "agent-runner-chats-"));

import { buildPiRuntime, ChatManager, KeyedQueue } from "../src/core/agent-runner.ts";
import { Session } from "../src/core/session.ts";
import { defaultPolicy } from "../src/core/tool-policy.ts";
import { chatStore } from "../src/core/chat-store.ts";

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
