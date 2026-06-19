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
