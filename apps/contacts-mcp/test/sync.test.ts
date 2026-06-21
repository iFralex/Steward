import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import { syncIndex, sourceHash } from "../src/sync.ts";
import type { Contact } from "../src/types.ts";

function c(uid: string, first: string, org: string | null = null): Contact {
  return { uid, firstName: first, lastName: null, organization: org, nickname: null, note: null,
    emails: [{ address: `${first.toLowerCase()}@x.com`, label: null }], phones: [], sources: ["s1"] };
}

test("syncIndex upserts, embeds new, re-embeds nothing unchanged, deletes vanished", async () => {
  const index = IndexDb.open(":memory:");
  const cfg = { endpoint: "http://x/v1/embeddings", model: "local-embed" };
  const embedBatch = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);
  let people = [c("U1", "Anna"), c("U2", "Bea")];
  const store = { allForIndex: () => people };
  const r1 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r1.upserted, 2);
  assert.equal(r1.embedded, 2);
  const r2 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r2.embedded, 0);
  people = [c("U1", "Anna")];
  const r3 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r3.deleted, 1);
  index.close();
});

test("sourceHash changes when organization changes", () => {
  assert.notEqual(sourceHash(c("U1", "Anna", "A")), sourceHash(c("U1", "Anna", "B")));
});
