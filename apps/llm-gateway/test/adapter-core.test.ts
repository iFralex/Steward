// apps/llm-gateway/test/adapter-core.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitPrompt, collectAssistantText, handleChatCompletion, type ChatMessage } from "../src/adapter-core.ts";

async function* fakeQuery(text: string): AsyncIterable<unknown> {
  yield { type: "system", session_id: "s1" };
  yield { type: "assistant", message: { content: [{ type: "text", text }] } };
  yield { type: "assistant", message: { content: [{ type: "tool_use", name: "x", input: {} }] } };
}

test("splitPrompt separates system from a single user message", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "You classify." },
    { role: "user", content: "Is this junk?" },
  ];
  const r = splitPrompt(msgs);
  assert.equal(r.systemPrompt, "You classify.");
  assert.equal(r.prompt, "Is this junk?");
});

test("splitPrompt renders multiple turns and has no systemPrompt when absent", () => {
  const r = splitPrompt([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "bye" },
  ]);
  assert.equal(r.systemPrompt, undefined);
  assert.equal(r.prompt, "user: hi\n\nassistant: hello\n\nuser: bye");
});

test("collectAssistantText concatenates only text blocks of assistant messages", async () => {
  assert.equal(await collectAssistantText(fakeQuery("hello world")), "hello world");
});

test("handleChatCompletion returns an OpenAI chat.completion with the assistant text", async () => {
  const runQuery = (_a: { prompt: string }) => fakeQuery('{"ok":true}');
  const res = (await handleChatCompletion(
    { model: "claude-opus-sub", messages: [{ role: "user", content: "go" }] },
    runQuery,
    () => 1000,
  )) as any;
  assert.equal(res.object, "chat.completion");
  assert.equal(res.created, 1);
  assert.equal(res.model, "claude-opus-sub");
  assert.equal(res.choices[0].message.role, "assistant");
  assert.equal(res.choices[0].message.content, '{"ok":true}');
  assert.equal(res.choices[0].finish_reason, "stop");
});
