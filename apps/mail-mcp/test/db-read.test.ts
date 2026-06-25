import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { readDb } from "../src/db-read.ts";
import { scopedReadScript } from "../src/applescript.ts";

const US = "\x1f";
function row(id: string, state: "full" | "none"): MessageRow {
  return {
    messageId: id, account: "Polimi", mailbox: "Posta in arrivo", fromName: "A", fromAddr: "a@x",
    to: ["me@x"], cc: [], subject: "Subj", date: 1750000000, bodyText: state === "full" ? "FULL BODY" : "",
    bodyState: state, source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
    toNames: [], ccNames: [], unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null,
  };
}

test("readDb returns the DB body when full (no AppleScript)", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a@x", "full"));
  let ran = false;
  const d = await readDb(s, { messageId: "a@x" }, async () => { ran = true; return ""; });
  assert.equal(d.body, "FULL BODY");
  assert.equal(d.bodyState, "full");
  assert.equal(ran, false);
  s.close();
});

test("readDb falls back to scoped AppleScript when not full", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("b@x", "none"));
  const fake = ["Subj", "A <a@x>", "2026", "DOWNLOADED"].join(US);
  const d = await readDb(s, { messageId: "b@x" }, async () => fake);
  assert.ok(d.body.includes("DOWNLOADED"));
  s.close();
});

test("readDb falls back to the partial mirror body when the live AppleScript read fails", async () => {
  const s = Store.open(":memory:");
  const r: MessageRow = { ...row("p@x", "none"), bodyState: "partial", bodyText: "PARTIAL TICKET BODY" };
  s.upsertMessage(r);
  // Simulate the Gmail "Tutti i messaggi" scoping failure: AppleScript throws.
  const d = await readDb(s, { messageId: "p@x" }, async () => { throw new Error("Message not found: id 123"); });
  assert.equal(d.body, "PARTIAL TICKET BODY", "must return the partial body, not fail");
  assert.equal(d.bodyState, "partial");
  s.close();
});

test("scopedReadScript narrows to the given account + mailbox", () => {
  const sc = scopedReadScript("Polimi", "Posta in arrivo", "id@x");
  assert.match(sc, /name of acct is "Polimi"/);
  assert.match(sc, /name of mb is "Posta in arrivo"/);
  assert.match(sc, /whose message id is "id@x"/);
});

test("readDb throws a clear error when the message is unknown", async () => {
  const s = Store.open(":memory:");
  await assert.rejects(() => readDb(s, { messageId: "missing@x" }), /not found/i);
  s.close();
});

// Fix 2: soft-deleted message should throw not-found, not return the record
test("readDb throws not-found for a soft-deleted message", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("del@x", "full"));
  s.softDelete("del@x");
  await assert.rejects(
    () => readDb(s, { messageId: "del@x" }),
    /not found/i,
    "soft-deleted message must not be readable",
  );
  s.close();
});

// Fix 5: date field in readDb is ISO-8601
test("readDb date field is ISO-8601", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("iso@x", "full"));
  const d = await readDb(s, { messageId: "iso@x" }, async () => "");
  assert.ok(!Number.isInteger(Number(d.date)), `date should not be a plain integer string, got: ${d.date}`);
  assert.ok(!Number.isNaN(Date.parse(d.date)), `date should be ISO-8601 parseable, got: ${d.date}`);
  s.close();
});
