// apps/llm-gateway/test/extract-json.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson } from "../src/extract-json.ts";

test("parses a bare JSON object", () => {
  assert.deepEqual(extractJson('{"a": 1, "b": "x"}'), { a: 1, b: "x" });
});

test("strips a ```json fence and surrounding prose", () => {
  const s = 'Sure! Here is the result:\n```json\n{"role": "drafts"}\n```\nLet me know.';
  assert.deepEqual(extractJson(s), { role: "drafts" });
});

test("normalizes curly quotes and parses", () => {
  assert.deepEqual(extractJson('{"key": "value"}'), { key: "value" });
});

test("extracts the first array", () => {
  assert.deepEqual(extractJson('noise [1, 2, 3] trailing'), [1, 2, 3]);
});

test("strips zero-width / BOM chars", () => {
  assert.deepEqual(extractJson('﻿{"a":​1}'), { a: 1 });
});

test("throws when there is no JSON", () => {
  assert.throws(() => extractJson("just prose, no json here"), /no JSON/i);
});

test("throws TypeError on non-string input", () => {
  // @ts-expect-error intentional wrong type
  assert.throws(() => extractJson(42), TypeError);
});
