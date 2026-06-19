// apps/mail-mcp/test/db-search-trig.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { searchDb } from "../src/db-search.ts";

function row(over: Partial<MessageRow>): MessageRow {
  return {
    messageId: "m", account: "A", mailbox: "INBOX", fromName: "Tom Jones", fromAddr: "a@b",
    to: ["x@y"], cc: [], toNames: ["Cristiana Rossi"], ccNames: [], subject: "Hi", date: 1750000000,
    bodyText: "hello world", bodyState: "full", source: "emlx", emlxPath: null, inReplyTo: null,
    references: [], gmThrid: null, size: 1, unread: false, flagged: false, answered: false, junk: false,
    flagColor: null, appleThrid: null, ...over,
  };
}

test("field-scoped trigram param filters by substring in that field", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row({ messageId: "m1", toNames: ["Cristiana Rossi"] }));
  s.upsertMessage(row({ messageId: "m2", toNames: ["Marco Bianchi"] }));
  const hits = await searchDb(s, { toName: "ristian", perMessage: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1");
  s.close();
});

test("multiple field-scoped params AND together", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row({ messageId: "m1", fromName: "Tom Jones", subject: "Invoice 2025" }));
  s.upsertMessage(row({ messageId: "m2", fromName: "Tom Jones", subject: "Holiday" }));
  const hits = await searchDb(s, { fromName: "Jones", subjectContains: "nvoice", perMessage: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1");
  s.close();
});
