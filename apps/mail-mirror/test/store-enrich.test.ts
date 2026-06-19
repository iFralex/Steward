// apps/mail-mirror/test/store-enrich.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    messageId: "m1", account: "ACC", mailbox: "INBOX", fromName: "Tom", fromAddr: "a@b",
    to: ["me@x"], cc: [], toNames: ["Cristiana Rossi"], ccNames: [], subject: "Hi", date: 1750000000,
    bodyText: "body", bodyState: "full", source: "emlx", emlxPath: "/p/m1", inReplyTo: null,
    references: [], gmThrid: null, size: 1, unread: true, flagged: true, answered: false, junk: false,
    flagColor: 2, appleThrid: 80147, ...over,
  };
}

test("upsertMessage persists flags, names, color and apple_thrid", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  const r = s.raw.prepare("SELECT unread, flagged, answered, junk, flag_color, apple_thrid, to_names FROM messages WHERE message_id='m1'").get() as Record<string, unknown>;
  assert.equal(r.unread, 1);
  assert.equal(r.flagged, 1);
  assert.equal(r.answered, 0);
  assert.equal(r.flag_color, 2);
  assert.equal(r.apple_thrid, 80147);
  assert.equal(JSON.parse(r.to_names as string)[0], "Cristiana Rossi");
  s.close();
});

test("trigram index matches an arbitrary substring inside a recipient name", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  const hits = s.searchTrig("to_names", "ristian", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1");
  s.close();
});
