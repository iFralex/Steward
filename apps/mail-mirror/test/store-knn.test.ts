import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";

function row(id: string, subject: string): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], subject, date: 1750000000, bodyText: subject, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

test("upsertEmbedding + knn returns the nearest message; state + needing queries", () => {
  const s = Store.open(":memory:");
  s.enableVectors();
  s.ensureVecTable(4);
  s.upsertMessage(row("a@x", "trains"));
  s.upsertMessage(row("b@x", "cooking"));
  s.upsertEmbedding("a@x", [1, 0, 0, 0], "mod", "ha");
  s.upsertEmbedding("b@x", [0, 0, 1, 0], "mod", "hb");

  const hits = s.knn([0.95, 0.05, 0, 0], 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "a@x");

  assert.equal(s.embedStateFor("a@x")?.sourceHash, "ha");
  assert.equal(s.embeddedCount(), 2);

  // c@x has no embedding -> needs embedding
  s.upsertMessage(row("c@x", "new"));
  const need = s.messagesNeedingEmbedding(10).map((m) => m.messageId);
  assert.ok(need.includes("c@x"));
  assert.ok(!need.includes("a@x"));
  s.close();
});
