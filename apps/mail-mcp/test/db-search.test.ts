import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { searchDb } from "../src/db-search.ts";

function row(id: string, subject: string, body: string, thread: number, date = 1750000000): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "T", fromAddr: "noreply@trenitalia.it",
    to: ["me@x"], cc: [], subject, date, bodyText: body, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

function seeded(): Store {
  const s = Store.open(":memory:");
  s.enableVectors(); s.ensureVecTable(4);
  s.upsertMessage(row("a@x", "Sconto viaggi", "Frecciarossa Roma Milano -20%", 1));
  s.setThreadId("a@x", 1);
  s.upsertMessage(row("b@x", "Ricetta torta", "uova farina zucchero", 2));
  s.setThreadId("b@x", 2);
  return s;
}

test("FTS-only search finds the travel promo by body term", async () => {
  const s = seeded();
  const hits = await searchDb(s, { query: "frecciarossa", limit: 5 });
  assert.equal(hits[0].messageId, "a@x");
  assert.ok(!hits.find((h) => h.messageId === "b@x"));
  s.close();
});

test("hybrid: vector ranking fused via RRF (stub embedder)", async () => {
  const s = seeded();
  s.upsertEmbedding("a@x", [1, 0, 0, 0], "m", "ha");
  s.upsertEmbedding("b@x", [0, 0, 1, 0], "m", "hb");
  // query embed near a@x; query term matches neither subject/body strongly
  const hits = await searchDb(s, { query: "treni veloci", limit: 5 }, async () => [0.95, 0.05, 0, 0]);
  assert.equal(hits[0].messageId, "a@x");
  s.close();
});

test("filters apply; thread grouping returns one row per thread", async () => {
  const s = seeded();
  s.upsertMessage(row("a2@x", "Re: Sconto viaggi", "altra promo treni", 1)); // same thread 1
  s.setThreadId("a2@x", 1);
  const hits = await searchDb(s, { query: "viaggi", limit: 10 });
  const t1 = hits.filter((h) => h.threadId === 1);
  assert.equal(t1.length, 1); // grouped
  s.close();
});

test("no query returns recent-first filtered messages", async () => {
  const s = seeded();
  const hits = await searchDb(s, { sender: "trenitalia", limit: 5 });
  assert.ok(hits.find((h) => h.messageId === "a@x"));
  s.close();
});
