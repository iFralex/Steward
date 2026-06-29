import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { readDb } from "../src/db-read.ts";

const US = "\x1f";
function row(id: string, state: "full" | "none"): MessageRow {
  return {
    messageId: id, account: "Polimi", mailbox: "Posta in arrivo", fromName: "A", fromAddr: "a@x",
    to: ["me@x"], cc: [], subject: "Subj", date: 1750000000, bodyText: state === "full" ? "FULL BODY" : "",
    bodyState: state, source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
    toNames: [], ccNames: [], unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null,
  };
}
// A live-read result: subject US sender US date US body (what parse.ts expects).
const liveOut = (body: string) => ["Subj", "A <a@x>", "2026", body].join(US);

test("readDb returns the DB body when full (no live read)", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a@x", "full"));
  let ran = false;
  const d = await readDb(s, { messageId: "a@x" }, async () => { ran = true; return ""; });
  assert.equal(d.body, "FULL BODY");
  assert.equal(d.bodyState, "full");
  assert.equal(ran, false);
  assert.equal(d.mailUrl, "message://%3Ca@x%3E", "exposes a clickable Apple Mail link");
  s.close();
});

test("readDb serves a substantial partial body straight from the mirror (no live read)", async () => {
  const s = Store.open(":memory:");
  const r: MessageRow = { ...row("p2@x", "none"), bodyState: "partial", bodyText: "This is the full extracted body text from the mirror." };
  s.upsertMessage(r);
  let ran = false;
  const d = await readDb(s, { messageId: "p2@x" }, async () => { ran = true; return ""; });
  assert.equal(ran, false, "must NOT do a live read when the mirror already has the body");
  assert.equal(d.body, "This is the full extracted body text from the mirror.");
  assert.equal(d.bodyState, "partial");
  s.close();
});

test("readDb completes a non-full body with a live read", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("b@x", "none"));
  const d = await readDb(s, { messageId: "b@x" }, async () => liveOut("DOWNLOADED"));
  assert.ok(d.body.includes("DOWNLOADED"));
  assert.equal(d.bodyState, "full");
  s.close();
});

test("readDb uses the INDEXED native id (whose id is) when an id is given", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("c@x", "none"));
  let script = "";
  await readDb(s, { id: "8821", messageId: "c@x" }, async (sc) => { script = sc; return liveOut("X"); });
  assert.match(script, /whose id is 8821/, "must use the fast indexed id lookup");
  assert.doesNotMatch(script, /name of mb is/, "must NOT scope by mailbox name (Gmail All Mail breaks that)");
  s.close();
});

test("readDb falls back to a GLOBAL message-id scan when no native id is given", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("d@x", "none"));
  let script = "";
  await readDb(s, { messageId: "d@x" }, async (sc) => { script = sc; return liveOut("X"); });
  assert.match(script, /whose message id is "d@x"/);
  assert.match(script, /repeat with acct in accounts/, "global scan across all accounts/mailboxes");
  assert.doesNotMatch(script, /name of mb is/, "no mailbox-name scoping");
  s.close();
});

test("readDb falls back to the partial mirror body when the live read fails", async () => {
  const s = Store.open(":memory:");
  const r: MessageRow = { ...row("p@x", "none"), bodyState: "partial", bodyText: "PARTIAL TICKET BODY" };
  s.upsertMessage(r);
  // Simulate the Gmail scoping failure: the live read throws.
  const d = await readDb(s, { messageId: "p@x" }, async () => { throw new Error("Message not found: id 123"); });
  assert.equal(d.body, "PARTIAL TICKET BODY", "must return the partial body, not fail");
  assert.equal(d.bodyState, "partial");
  s.close();
});

test("readDb keeps the richer mirror body when the live read is emptier (PDF-only ticket)", async () => {
  const s = Store.open(":memory:");
  const r: MessageRow = { ...row("rich@x", "none"), bodyState: "partial", bodyText: "A".repeat(4000) };
  s.upsertMessage(r);
  // Live content is basically empty (the real content is in PDF attachments).
  const d = await readDb(s, { messageId: "rich@x" }, async () => liveOut("   "));
  assert.equal(d.body.length, 4000, "must keep the richer mirror partial, not the empty live body");
  assert.equal(d.bodyState, "partial");
  s.close();
});

test("readDb keeps the partial body when the live read reports it unavailable", async () => {
  const s = Store.open(":memory:");
  const r: MessageRow = { ...row("u@x", "none"), bodyState: "partial", bodyText: "PARTIAL" };
  s.upsertMessage(r);
  const d = await readDb(s, { messageId: "u@x" }, async () => liveOut("[body unavailable: timeout]"));
  assert.equal(d.body, "PARTIAL");
  s.close();
});

test("readDb throws a clear error when the message is unknown", async () => {
  const s = Store.open(":memory:");
  await assert.rejects(() => readDb(s, { messageId: "missing@x" }), /not found/i);
  s.close();
});

test("readDb throws not-found for a soft-deleted message", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("del@x", "full"));
  s.softDelete("del@x");
  await assert.rejects(() => readDb(s, { messageId: "del@x" }), /not found/i);
  s.close();
});

test("readDb date field is ISO-8601", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("iso@x", "full"));
  const d = await readDb(s, { messageId: "iso@x" }, async () => "");
  assert.ok(!Number.isNaN(Date.parse(d.date)), `date should be ISO-8601, got: ${d.date}`);
  s.close();
});
