import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    messageId: "m1@x",
    account: "ACC", mailbox: "INBOX",
    fromName: "Trenitalia", fromAddr: "noreply@trenitalia.it",
    to: ["me@x"], cc: [],
    subject: "Sconto -20% viaggi", date: 1750000000,
    bodyText: "Frecciarossa Roma Milano FRECCIA20",
    bodyState: "full", source: "emlx", emlxPath: "/p/1.emlx",
    inReplyTo: null, references: [], gmThrid: null, size: 100,
    ...overrides,
  };
}

test("upsert dedups by messageId and FTS finds body terms", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  s.upsertMessage(row({ subject: "Sconto -20% viaggi (updated)" })); // same id -> update
  const hits = s.searchFts("frecciarossa", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1@x");
  assert.ok(hits[0].subject.includes("updated"));
  s.close();
});

test("attachments and soft delete", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  s.insertAttachments("m1@x", [{ filename: "p.pdf", mime: "application/pdf", size: 5, sha256: "abcd", relPath: "ab/abcd", downloaded: true }]);
  s.softDelete("m1@x");
  const got = s.getMessage("m1@x");
  assert.ok(got); // row remains (soft delete)
  const raw = s.raw.prepare("SELECT deleted FROM messages WHERE message_id=?").get("m1@x") as { deleted: number };
  assert.equal(raw.deleted, 1);
  s.close();
});

test("state get/set round-trips", () => {
  const s = Store.open(":memory:");
  s.setState("backfill.cursor", "42");
  assert.equal(s.getState("backfill.cursor"), "42");
  assert.equal(s.getState("missing"), undefined);
  s.close();
});
