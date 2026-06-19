import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";

function row(id: string): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], subject: "s" + id, date: 1750000000, bodyText: "body", bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
    toNames: [], ccNames: [], unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null,
  };
}

test("enableVectors loads sqlite-vec and a vec table can be created", () => {
  const s = Store.open(":memory:");
  assert.equal(s.enableVectors(), true);
  s.ensureVecTable(4);
  // idempotent
  s.ensureVecTable(4);
  const v = s.raw.prepare("select vec_version() as v").get() as { v: string };
  assert.match(v.v, /^v?\d/);
  // embed_state table exists
  s.raw.prepare("INSERT INTO embed_state(message_id, model, dim, source_hash, embedded_at) VALUES ('m1','mod',4,'h',1)").run();
  const r = s.raw.prepare("SELECT model FROM embed_state WHERE message_id='m1'").get() as { model: string };
  assert.equal(r.model, "mod");
  s.close();
});

test("ensureVecTable rebuilds when dim changes: clears embed_state and accepts new-dim vectors", () => {
  const s = Store.open(":memory:");
  s.enableVectors();
  // embed at dim 4
  s.ensureVecTable(4);
  s.upsertMessage(row("m1@x"));
  s.upsertEmbedding("m1@x", [1, 0, 0, 0], "mod", "h1");
  assert.equal(s.embeddedCount(), 1);

  // dim changes to 2: table must be rebuilt and embed_state cleared
  s.ensureVecTable(2);
  assert.equal(s.embeddedCount(), 0, "embed_state must be cleared after dim change");

  // new 2-dim vector must be accepted and KNN must find the message
  s.upsertEmbedding("m1@x", [1, 0], "mod", "h2");
  const hits = s.knn([0.9, 0.1], 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1@x");
  s.close();
});
