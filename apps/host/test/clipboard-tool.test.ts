import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClipboardTool } from "../src/core/clipboard-tool.ts";

type Res = { content: { type: string; text: string }[] };
const parse = (r: unknown) => JSON.parse((r as Res).content[0].text);
const call = (params: unknown) =>
  (buildClipboardTool().execute as unknown as (id: string, p: unknown) => Promise<Res>)("id", params);

test("copy_to_clipboard validates and reports copied text metadata", async () => {
  const res = await call({ text: "ciao", label: "Greeting" });
  assert.deepEqual(parse(res), { copied: true, length: 4, label: "Greeting" });
});

test("copy_to_clipboard rejects missing text", async () => {
  const res = await call({ label: "Empty" });
  assert.deepEqual(parse(res), { copied: false, error: "copy_to_clipboard requires non-empty text" });
});
