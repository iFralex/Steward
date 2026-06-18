import assert from "node:assert/strict";
import { test } from "node:test";
import { isEmail, assertEmails, assertSafeDestPath } from "../src/validate.ts";

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
