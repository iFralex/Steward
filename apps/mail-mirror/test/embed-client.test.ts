import assert from "node:assert/strict";
import { test } from "node:test";
import { embedText } from "../src/embed-client.ts";

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
