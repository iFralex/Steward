// apps/mail-promoter/test/prefilter.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldConsider } from "../src/prefilter.ts";

const base = { fromAddr: "anna@friend.com", subject: "Lunch next week?", bodyState: "full" };

test("keeps an ordinary personal email", () => {
  assert.equal(shouldConsider(base), true);
});

test("drops junk/spam/bulk by mailbox role", () => {
  assert.equal(shouldConsider(base, "junk"), false);
  assert.equal(shouldConsider(base, "spam"), false);
  assert.equal(shouldConsider(base, "bulk"), false);
  assert.equal(shouldConsider(base, "inbox"), true);
});

test("drops no-reply / notification / newsletter senders", () => {
  for (const a of ["noreply@x.com", "no-reply@x.com", "notifications@x.com", "newsletter@x.com", "mailer@x.com"]) {
    assert.equal(shouldConsider({ ...base, fromAddr: a }), false, a);
  }
});

test("drops OTP / verification-code subjects", () => {
  assert.equal(shouldConsider({ ...base, subject: "Your verification code is 384921" }), false);
  assert.equal(shouldConsider({ ...base, subject: "123456 is your one-time code" }), false);
});

test("drops empty-bodied (none) messages", () => {
  assert.equal(shouldConsider({ ...base, bodyState: "none" }), false);
});

test("keeps non-OTP subjects that merely contain code-related words (no numeric code)", () => {
  for (const s of ["Security code review meeting tomorrow", "How to access the code repo", "Here is your documentation code sample"]) {
    assert.equal(shouldConsider({ ...base, subject: s }), true, s);
  }
});

test("still drops an explicit OTP subject without a number", () => {
  assert.equal(shouldConsider({ ...base, subject: "Your OTP for login" }), false);
  assert.equal(shouldConsider({ ...base, subject: "Your one-time password" }), false);
});
