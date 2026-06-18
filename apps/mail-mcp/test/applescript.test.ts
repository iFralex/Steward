import assert from "node:assert/strict";
import { test } from "node:test";
import { esc, sendScript, searchScript, replyScript } from "../src/applescript.ts";

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
