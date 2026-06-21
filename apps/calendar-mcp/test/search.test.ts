import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import { hybridSearch } from "../src/search.ts";
import type { CalEvent } from "../src/types.ts";

function ev(uid: string, summary: string): CalEvent {
  return { uid, summary, description: null, location: null, start: "2026-06-25T10:00:00.000Z",
    end: "2026-06-25T11:00:00.000Z", allDay: false, calendar: "Casa", account: "iCloud", status: 1, url: null, lastModified: 1 };
}

test("hybrid falls back to FTS-only when no embedder", async () => {
  const index = IndexDb.open(":memory:");
  index.upsertEvent(ev("U1", "Dentist appointment"), "h1");
  index.upsertEvent(ev("U2", "Team standup"), "h2");
  const out = await hybridSearch({ index }, "dentist", 10);
  assert.deepEqual(out, ["U1"]);
  index.close();
});

test("hybrid merges vector hits with FTS via RRF", async () => {
  const index = IndexDb.open(":memory:");
  const r1 = index.upsertEvent(ev("U1", "Dentist"), "h1");
  const r2 = index.upsertEvent(ev("U2", "Doctor"), "h2");
  index.vectors.enable();
  index.vectors.ensureTable(3);
  index.vectors.upsert(r1, [1, 0, 0]);
  index.vectors.upsert(r2, [0.9, 0.1, 0]);
  // query matches U2 by vector, neither strongly by FTS token "checkup"
  const out = await hybridSearch({ index, embedQuery: async () => [0.85, 0.15, 0] }, "checkup", 10);
  assert.ok(out.includes("U2"));
  index.close();
});
