import { test } from "node:test";
import assert from "node:assert/strict";
import { callStartRoute, parseCallStartBody, tokenOk } from "../src/server.ts";

const TOKEN = "abcDEF123-_xyz789";

test("valid token via ?token= query is accepted", () => {
  assert.equal(tokenOk(`/usage?token=${TOKEN}`, undefined, TOKEN), true);
});

test("valid token via Authorization: Bearer header is accepted", () => {
  assert.equal(tokenOk("/usage", `Bearer ${TOKEN}`, TOKEN), true);
});

test("query token wins when both query and header are present", () => {
  assert.equal(tokenOk(`/usage?token=${TOKEN}`, "Bearer wrong-token", TOKEN), true);
});

test("wrong token (query) is rejected", () => {
  assert.equal(tokenOk("/usage?token=nope", undefined, TOKEN), false);
});

test("wrong token (header) is rejected", () => {
  assert.equal(tokenOk("/usage", "Bearer nope", TOKEN), false);
});

test("missing token (no query, no header) is rejected", () => {
  assert.equal(tokenOk("/usage", undefined, TOKEN), false);
});

test("malformed Authorization header (no Bearer prefix) is rejected", () => {
  assert.equal(tokenOk("/usage", TOKEN, TOKEN), false);
});

test("length mismatch does not throw and is rejected", () => {
  assert.doesNotThrow(() => tokenOk("/usage?token=short", undefined, TOKEN));
  assert.equal(tokenOk("/usage?token=short", undefined, TOKEN), false);
  assert.doesNotThrow(() => tokenOk(`/usage?token=${TOKEN}-and-then-some-more`, undefined, TOKEN));
  assert.equal(tokenOk(`/usage?token=${TOKEN}-and-then-some-more`, undefined, TOKEN), false);
});

test("an unparseable url does not throw and is rejected (falls back to header)", () => {
  assert.doesNotThrow(() => tokenOk("::not a url::", `Bearer ${TOKEN}`, TOKEN));
});

test("quick-call and voice/call are exact call-start routes", () => {
  assert.equal(callStartRoute("/quick-call"), "quick");
  assert.equal(callStartRoute("/quick-call?token=x"), "quick");
  assert.equal(callStartRoute("/voice/call"), "voice");
  assert.equal(callStartRoute("/voice/call/status"), null);
  assert.equal(callStartRoute("/quick-call-evil"), null);
});

test("quick-call accepts an empty body or idempotency key, but no text", () => {
  assert.deepEqual(parseCallStartBody("quick", ""), {});
  assert.deepEqual(parseCallStartBody("quick", '{"requestId":"shortcut-42"}'), { requestId: "shortcut-42" });
  assert.throws(() => parseCallStartBody("quick", '{"openingLine":"ciao"}'), /does not accept/);
  assert.throws(() => parseCallStartBody("quick", '{"text":"ciao"}'), /does not accept field/);
  assert.deepEqual(parseCallStartBody("voice", '{"openingLine":"ciao"}'), { openingLine: "ciao" });
});
