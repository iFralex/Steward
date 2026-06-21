import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import { syncIndex, sourceHash } from "../src/sync.ts";
import type { CalEvent } from "../src/types.ts";

function ev(uid: string, summary: string): CalEvent {
  return { uid, summary, description: null, location: null, start: "2026-06-25T10:00:00.000Z",
    end: "2026-06-25T11:00:00.000Z", allDay: false, calendar: "Casa", account: "iCloud", status: 1, url: null, lastModified: 1 };
}

test("syncIndex upserts, embeds new, and deletes vanished", async () => {
  const index = IndexDb.open(":memory:");
  const cfg = { endpoint: "http://x/v1/embeddings", model: "local-embed" };
  const embedBatch = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);
  let events = [ev("U1", "Dentist"), ev("U2", "Standup")];
  const store = { allForIndex: () => events };
  const r1 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r1.upserted, 2);
  assert.equal(r1.embedded, 2);
  // Re-run with no changes: nothing re-embedded
  const r2 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r2.embedded, 0);
  // Drop U2
  events = [ev("U1", "Dentist")];
  const r3 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r3.deleted, 1);
  index.close();
});

test("sourceHash changes when summary changes", () => {
  assert.notEqual(sourceHash(ev("U1", "a")), sourceHash(ev("U1", "b")));
});
