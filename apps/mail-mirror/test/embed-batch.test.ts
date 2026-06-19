/**
 * Tests for the batched embedBackfill path (deps.embedBatch present).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";
import { embedBackfill, sourceHash, sourceTextFor, type EmbedDeps } from "../src/embed.ts";

function row(id: string, subject: string, body = "body", date = 1_750_000_000): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], subject, date, bodyText: body, bodyState: "full",
    source: "emlx", emlxPath: `/p/${id}`, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

/** Build EmbedDeps with a batch function that returns the provided vectors in order. */
function batchDeps(store: Store, vectorsPerCall: (number[] | null)[][]): EmbedDeps {
  let call = 0;
  return {
    store,
    model: "mod",
    embed: async () => null, // single-embed not used in batch path
    embedBatch: async (texts) => {
      const vs = vectorsPerCall[call] ?? texts.map(() => null);
      call++;
      return vs;
    },
  };
}

test("batched backfill embeds all new messages in one chunk", async () => {
  const s = Store.open(":memory:");
  s.enableVectors();
  s.upsertMessage(row("a@x", "Hello", "world", 1000));
  s.upsertMessage(row("b@x", "Bye", "world", 2000));

  const deps = batchDeps(s, [[[1, 0], [0, 1]]]);
  const res = await embedBackfill(deps, { limit: 10 });

  assert.equal(res.embedded, 2);
  assert.equal(res.unavailable, false);
  assert.equal(s.embeddedCount(), 2);
  s.close();
});

test("batched backfill skips messages whose source hash is unchanged", async () => {
  const s = Store.open(":memory:");
  s.enableVectors();
  s.upsertMessage(row("a@x", "Hello", "world"));
  s.upsertMessage(row("b@x", "New",   "msg"));

  // Pre-embed "a@x" so it already has a matching hash.
  const textA = sourceTextFor(row("a@x", "Hello", "world"));
  const hashA = sourceHash(textA);
  s.ensureVecTable(2);
  s.upsertEmbedding("a@x", [9, 9], "mod", hashA);

  // Only "b@x" should be in the pending batch.
  let batchTexts: string[] = [];
  const deps: EmbedDeps = {
    store: s,
    model: "mod",
    embed: async () => null,
    embedBatch: async (texts) => {
      batchTexts = texts;
      return texts.map(() => [0, 1]);
    },
  };

  const res = await embedBackfill(deps, { limit: 10 });

  assert.equal(res.embedded, 1);
  assert.equal(res.unavailable, false);
  // Should have been called with only "b@x"'s text (one item).
  assert.equal(batchTexts.length, 1);
  s.close();
});

test("all-null batch chunk stops with unavailable:true and writes no state", async () => {
  const s = Store.open(":memory:");
  s.enableVectors();
  s.upsertMessage(row("a@x", "Hello", "world"));
  s.upsertMessage(row("b@x", "Bye",   "world"));

  const deps = batchDeps(s, [[null, null]]); // endpoint down
  const res = await embedBackfill(deps, { limit: 10 });

  assert.equal(res.unavailable, true);
  assert.equal(res.embedded, 0);
  // No embeddings should have been written.
  assert.equal(s.embeddedCount(), 0);
  s.close();
});

test("partial-null batch: non-null vectors are saved, null ones are skipped", async () => {
  const s = Store.open(":memory:");
  s.enableVectors();
  s.upsertMessage(row("a@x", "Hello", "world", 1000));
  s.upsertMessage(row("b@x", "Bye",   "world", 2000));

  // First vector ok, second null (partial failure — not all-null, so not unavailable).
  const deps = batchDeps(s, [[[1, 0], null]]);
  const res = await embedBackfill(deps, { limit: 10 });

  assert.equal(res.embedded, 1);
  assert.equal(res.unavailable, false);
  assert.equal(s.embeddedCount(), 1);
  s.close();
});
