import assert from "node:assert/strict";
import { test } from "node:test";
import { esc, sendScript, searchScript, replyScript, mailboxesScript, readScript } from "../src/applescript.ts";

test("esc escapes backslashes and quotes for AppleScript literals", () => {
  assert.equal(esc('a "b" \\ c'), 'a \\"b\\" \\\\ c');
});

test("sendScript escapes body/subject and emits one recipient per address", () => {
  const s = sendScript({ to: ["x@y.co", "z@y.co"], subject: 'hi "there"', body: "line\\one" });
  assert.ok(s.includes('hi \\"there\\"'));
  assert.ok(s.includes("line\\\\one"));
  assert.equal((s.match(/make new to recipient/g) ?? []).length, 2);
  assert.ok(s.includes("x@y.co") && s.includes("z@y.co"));
  assert.ok(/\bsend\b/.test(s));
});

test("searchScript escapes the sender filter and bounds the limit", () => {
  const s = searchScript({ limit: 5, sender: 'boss"@co' });
  assert.ok(s.includes('boss\\"@co'));
  assert.ok(s.includes("≥ 5") || s.includes("> 4"));
});

test("replyScript sends a reply and honours replyAll", () => {
  const s = replyScript({ messageId: "id1", body: "ok", replyAll: true });
  assert.ok(s.includes("reply to all true"));
  assert.ok(/\bsend\b/.test(s));
});

test("mailboxesScript includes the account email addresses", () => {
  assert.ok(mailboxesScript().includes("email addresses of acct"));
});

test("searchScript with account filters by name OR email address", () => {
  const s = searchScript({ account: "alessio.antonucci@mail.polimi.it", sender: "x" });
  assert.ok(s.includes('email addresses contains "alessio.antonucci@mail.polimi.it"'));
  assert.ok(s.includes("repeat with acct in (accounts"));
});

test("readScript locates the message across all mailboxes, not just inbox", () => {
  const s = readScript("id1");
  assert.ok(s.includes("repeat with acct in accounts"));
  assert.ok(!s.includes("message of inbox"));
});
