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

test("sendScript sets the sender when `from` is given", () => {
  const s = sendScript({ from: "me@polimi.it", to: ["a@b.co"], subject: "x", body: "y" });
  assert.ok(s.includes('sender:"me@polimi.it"'));
});

test("sendScript omits the sender (default account) when `from` is absent", () => {
  const s = sendScript({ to: ["a@b.co"], subject: "x", body: "y" });
  assert.ok(!s.includes("sender:"));
});

test("searchScript escapes the sender filter and bounds the limit", () => {
  const s = searchScript({ limit: 5, sender: 'boss"@co' });
  assert.ok(s.includes('boss\\"@co'));
  assert.ok(s.includes("≥ 5") || s.includes("> 4"));
});

test("replyScript sends a reply and honours replyAll", () => {
  const s = replyScript({ messageId: "id1", body: "ok", replyAll: true });
  assert.ok(s.includes("opening window false"));
  assert.ok(s.includes("reply to all true"));
  assert.ok(/\bsend\b/.test(s));
});

test("replyScript sets the sender when `from` is given", () => {
  const s = replyScript({ messageId: "id1", from: "me@polimi.it", body: "ok" });
  assert.ok(s.includes('set sender to "me@polimi.it"'));
});

test("replyScript saves and verifies the reply body before sending", () => {
  const s = replyScript({ messageId: "id1", body: 'ok "quoted" \\ path' });
  assert.ok(s.includes("with timeout of 600 seconds"));
  assert.ok(s.includes('set replyBody to "ok \\"quoted\\" \\\\ path"'));
  assert.ok(s.includes("set quotedContent to"));
  assert.ok(s.includes("set finalBody to replyBody & return & return & quotedContent"));
  assert.equal((s.match(/set content to finalBody/g) ?? []).length, 1);
  assert.ok(s.includes("save r"));
  assert.ok(s.includes("observedBody does not contain replyBody"));
  assert.ok(s.indexOf("set content to finalBody") < s.indexOf("save r"));
  assert.ok(s.indexOf("save r") < s.indexOf("send"));
});

test("mailboxesScript includes the account email addresses", () => {
  assert.ok(mailboxesScript().includes("email addresses of acct"));
});

test("searchScript with account filters by name OR email address (repeat + is in)", () => {
  const s = searchScript({ account: "alessio.antonucci@mail.polimi.it", sender: "x" });
  assert.ok(s.includes('"alessio.antonucci@mail.polimi.it" is in (email addresses of acct)'));
  assert.ok(s.includes("repeat with acct in accounts"));
  // must NOT use the unsupported whose-on-list form
  assert.ok(!s.includes("email addresses contains"));
});

test("searchScript searches the fast unified inbox when no location filter is given", () => {
  const s = searchScript({ subject: "hi" });
  assert.ok(s.includes("messages of inbox"));
  assert.ok(!s.includes("repeat with acct in accounts"));
});

test("searchScript maps a standard mailbox name to its unified mailbox keyword", () => {
  assert.ok(searchScript({ mailbox: "Sent" }).includes("messages of sent mailbox"));
  assert.ok(searchScript({ mailbox: "Bozze" }).includes("messages of drafts mailbox"));
});

test("searchScript scopes an account search to the inbox mailbox by name (avoids archive scan)", () => {
  const s = searchScript({ account: "Polimi", limit: 5 });
  assert.ok(s.includes("repeat with mb in mailboxes of acct"));
  assert.ok(s.includes('name of mb is "Posta in arrivo"'));
  assert.ok(s.includes('name of mb is "Inbox"'));
  // not the unbounded unified scan
  assert.ok(!s.includes("set msgs to (messages of inbox"));
});

test("searchScript scopes an account Sent search to localized sent-folder names", () => {
  const s = searchScript({ account: "Polimi", mailbox: "Sent" });
  assert.ok(s.includes('name of mb is "Posta inviata"'));
  assert.ok(s.includes('name of mb is "Sent"'));
});

test("searchScript falls back to per-account folder iteration for a custom mailbox name", () => {
  const s = searchScript({ mailbox: "Projects/2026" });
  assert.ok(s.includes("repeat with mb in mailboxes of acct"));
  assert.ok(s.includes('name of mb is "Projects/2026"'));
});

test("readScript locates the message across all mailboxes, not just inbox", () => {
  const s = readScript({ messageId: "id1" });
  assert.ok(s.includes("repeat with acct in accounts"));
  assert.ok(!s.includes("message of inbox"));
});

test("readScript uses the indexed `whose id is` fast path when given a native id", () => {
  const s = readScript({ id: "93914" });
  assert.ok(s.includes("whose id is 93914"));
  assert.ok(!s.includes("whose message id is"));
});

test("readScript falls back to the slow `whose message id is` path for an RFC id", () => {
  const s = readScript({ messageId: "abc@host" });
  assert.ok(s.includes('whose message id is "abc@host"'));
});

test("readScript treats a non-numeric id as a message-id fallback", () => {
  const s = readScript({ id: "abc@host" });
  assert.ok(s.includes('whose message id is "abc@host"'));
  assert.ok(!s.includes("whose id is"));
});

test("searchScript record emits Mail's native id first for fast follow-up lookups", () => {
  assert.ok(searchScript({ limit: 5 }).includes("(id of m as string)"));
});
