import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import { hybridSearch } from "../src/search.ts";
import type { Contact } from "../src/types.ts";

function c(uid: string, first: string, org: string | null = null): Contact {
  return { uid, firstName: first, lastName: null, organization: org, nickname: null, note: null,
    emails: [{ address: `${first.toLowerCase()}@x.com`, label: null }], phones: [], sources: ["s1"] };
}

test("hybrid falls back to FTS-only when no embedder", async () => {
  const index = IndexDb.open(":memory:");
  index.upsertContact(c("U1", "Cristian"), "h1");
  index.upsertContact(c("U2", "Marco"), "h2");
  const out = await hybridSearch({ index }, "cristian", 10);
  assert.deepEqual(out, ["U1"]);
  index.close();
});

test("hybrid merges vector hits with FTS via RRF", async () => {
  const index = IndexDb.open(":memory:");
  const r1 = index.upsertContact(c("U1", "Anna", "Studio Commercialista"), "h1");
  const r2 = index.upsertContact(c("U2", "Bea"), "h2");
  index.vectors.enable();
  index.vectors.ensureTable(3);
  index.vectors.upsert(r1, [1, 0, 0]);
  index.vectors.upsert(r2, [0, 1, 0]);
  // semantic query close to U1 by vector, no FTS token match
  const out = await hybridSearch({ index, embedQuery: async () => [0.95, 0.05, 0] }, "accountant", 10);
  assert.ok(out.includes("U1"));
  index.close();
});
