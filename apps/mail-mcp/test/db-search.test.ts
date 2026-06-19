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

// Fix 3: FTS query sanitization — special chars do not throw
test("FTS: query with double-quote and asterisk does not throw and still matches", async () => {
  const s = Store.open(":memory:");
  // epoch 1735689600 = 2026-01-01T00:00:00Z
  s.upsertMessage(row("cats@x", "cats subject", "I love cats", 10, 1735689600));
  s.upsertMessage(row("dogs@x", "dogs subject", "dogs are great", 11, 1735689600));
  // Raw FTS5 would throw on unbalanced quote; ftsQuery should sanitise it
  const hits = await searchDb(s, { query: 'cats "', limit: 5 });
  assert.ok(hits.find((h) => h.messageId === "cats@x"), "cats message should be found");
  assert.ok(!hits.find((h) => h.messageId === "dogs@x"), "dogs message should not match");
  s.close();
});

// Fix 4: offset is honoured
test("offset skips leading results", async () => {
  const s = Store.open(":memory:");
  // Two messages, different thread_ids so grouping keeps both.
  // Use distinct dates so ordering is deterministic (no query => date DESC).
  s.upsertMessage(row("first@x", "First", "body first", 100, 1750000010));
  s.setThreadId("first@x", 100);
  s.upsertMessage(row("second@x", "Second", "body second", 101, 1750000000));
  s.setThreadId("second@x", 101);
  // Without offset both are returned; with offset:1,limit:1 we get the second (older).
  const all = await searchDb(s, { limit: 10, offset: 0 });
  assert.equal(all.length, 2);
  const offsetHits = await searchDb(s, { limit: 1, offset: 1 });
  assert.equal(offsetHits.length, 1);
  assert.equal(offsetHits[0].messageId, all[1].messageId);
  s.close();
});

// Fix 5: date output is ISO-8601 not raw epoch string
test("date field is ISO-8601", async () => {
  const s = seeded();
  const hits = await searchDb(s, { limit: 5 });
  for (const h of hits) {
    assert.ok(!Number.isInteger(Number(h.date)), `date should not be a plain integer string, got: ${h.date}`);
    assert.ok(!Number.isNaN(Date.parse(h.date)), `date should be ISO-8601 parseable, got: ${h.date}`);
  }
  s.close();
});
