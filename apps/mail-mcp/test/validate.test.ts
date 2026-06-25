import assert from "node:assert/strict";
import { test } from "node:test";
import { isEmail, assertEmails, assertSafeDestPath, resolveMessageRef } from "../src/validate.ts";

test("resolveMessageRef: numeric id -> fast id path; non-numeric id -> message-id path", () => {
  assert.deepEqual(resolveMessageRef({ id: "8821" }), { byId: true, id: "8821" });
  // The DB search returns the RFC Message-ID in `id` — it must NOT be rejected.
  assert.deepEqual(resolveMessageRef({ id: "PAXP251@OUTLOOK.COM" }), { byId: false, messageId: "PAXP251@OUTLOOK.COM" });
  assert.deepEqual(resolveMessageRef({ messageId: "m@x" }), { byId: false, messageId: "m@x" });
  assert.deepEqual(resolveMessageRef({ id: "abc@x", messageId: "m@x" }), { byId: false, messageId: "m@x" });
  assert.throws(() => resolveMessageRef({}), /required/);
});

test("isEmail accepts valid, rejects invalid", () => {
  assert.equal(isEmail("a@b.co"), true);
  assert.equal(isEmail("nope"), false);
  assert.equal(isEmail("a@b"), false);
});

test("assertEmails throws on empty or invalid recipient", () => {
  assert.throws(() => assertEmails([], "to"));
  assert.throws(() => assertEmails(["bad"], "to"));
  assert.doesNotThrow(() => assertEmails(["a@b.co"], "to"));
});

test("assertSafeDestPath rejects traversal and relative, accepts absolute", () => {
  assert.throws(() => assertSafeDestPath("../etc"));
  assert.throws(() => assertSafeDestPath("rel/dir"));
  assert.equal(assertSafeDestPath("/tmp/x"), "/tmp/x");
});
