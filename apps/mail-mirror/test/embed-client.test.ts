import assert from "node:assert/strict";
import { test } from "node:test";
import { embedText, embedTexts } from "../src/embed-client.ts";

const cfg = { endpoint: "http://127.0.0.1:1234/v1/embeddings", model: "m" };
const okFetch = (async () => ({
  ok: true, status: 200, statusText: "OK",
  json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), text: async () => "",
})) as unknown as typeof fetch;
const downFetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

test("embedText returns the vector on success", async () => {
  assert.deepEqual(await embedText("hi", cfg, okFetch), [0.1, 0.2, 0.3]);
});

test("embedText returns null when the endpoint is down", async () => {
  assert.equal(await embedText("hi", cfg, downFetch), null);
});

const batchOkFetch = (async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  const texts: string[] = body.input;
  return {
    ok: true, status: 200, statusText: "OK",
    json: async () => ({
      data: texts.map((_, i) => ({ index: i, embedding: [i * 0.1, i * 0.2] })),
    }),
    text: async () => "",
  };
}) as unknown as typeof fetch;

test("embedTexts returns per-text vectors in index order", async () => {
  const result = await embedTexts(["a", "b", "c"], cfg, batchOkFetch);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], [0, 0]);
  assert.deepEqual(result[1], [0.1, 0.2]);
  assert.deepEqual(result[2], [0.2, 0.4]);
});

test("embedTexts returns all-null when the endpoint is down", async () => {
  const result = await embedTexts(["x", "y"], cfg, downFetch);
  assert.ok(result.every((v) => v === null));
});
