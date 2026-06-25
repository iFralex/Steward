import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAskUserTool } from "../src/core/ask-user-tool.ts";

type Res = { content: { type: string; text: string }[] };
const parse = (r: unknown) => JSON.parse((r as Res).content[0].text);
// The Pi ToolDefinition.execute type takes more params than the impl uses
// (mcp-bridge casts the same way); invoke it with just (id, params) in tests.
const call = (tool: ReturnType<typeof buildAskUserTool>, params: unknown) =>
  (tool.execute as unknown as (id: string, p: unknown) => Promise<Res>)("id", params);

test("ask_user calls askQuestion and returns the selection as JSON", async () => {
  let received: unknown;
  const tool = buildAskUserTool(async (q) => { received = q; return ["B"]; });
  assert.equal(tool.name, "ask_user");
  const res = await call(tool, { question: "Quale?", options: ["A", "B"], multiSelect: false });
  assert.deepEqual(received, { question: "Quale?", options: ["A", "B"], multiSelect: false });
  assert.deepEqual(parse(res), { selected: ["B"] });
});

test("ask_user rejects a missing question or fewer than 2 options without asking", async () => {
  let called = false;
  const tool = buildAskUserTool(async () => { called = true; return []; });
  const r1 = await call(tool, { question: "q", options: ["only"] });
  assert.match(parse(r1).error, /at least 2 options/);
  const r2 = await call(tool, { options: ["A", "B"] });
  assert.match(parse(r2).error, /question/);
  assert.equal(called, false, "askQuestion must not be called on invalid input");
});

test("ask_user filters non-string options", async () => {
  const tool = buildAskUserTool(async (q) => q.options);
  const res = await call(tool, { question: "q", options: ["A", 5, "B", null] });
  assert.deepEqual(parse(res), { selected: ["A", "B"] });
});
