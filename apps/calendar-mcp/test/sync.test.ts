import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import { syncIndex, sourceHash } from "../src/sync.ts";
import type { CalEvent } from "../src/types.ts";

function ev(uid: string, summary: string): CalEvent {
  return { uid, summary, description: null, location: null, start: "2026-06-25T10:00:00.000Z",
    end: "2026-06-25T11:00:00.000Z", allDay: false, calendarId: "CAL-1", calendar: "Casa", account: "iCloud",
    alarms: [], hasRecurrence: false, status: 1, url: null, lastModified: 1 };
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


test("a failed source read does not publish a fresh completed snapshot", async () => {
  const index = IndexDb.open(":memory:");
  try {
    await syncIndex({ store: { allForIndex: () => [ev("kept", "Existing")] }, index, embedConfig: null });
    const completed = index.getState("completed_sync_started_at");
    await assert.rejects(syncIndex({ store: { allForIndex: () => { throw new Error("source unavailable"); } }, index, embedConfig: null }), /source unavailable/);
    assert.equal(index.getState("completed_sync_started_at"), completed);
    assert.ok(index.getEvent("kept"));
  } finally { index.close(); }
});

test("metadata snapshot completes before slow optional embeddings", async () => {
  const index = IndexDb.open(":memory:");
  let finish!: (vectors: number[][]) => void;
  const vectors = new Promise<number[][]>(resolve => { finish = resolve; });
  const pending = syncIndex({ store: { allForIndex: () => [ev("visible", "Pending vectors")] }, index,
    embedConfig: {endpoint:"http://fixture",model:"test"}, embedBatch: () => vectors });
  assert.ok(index.getState("completed_sync_started_at"));
  assert.ok(index.getEvent("visible"));
  finish([[0.1,0.2]]);
  await pending;
  index.close();
});


test("late embeddings cannot overwrite a newer event snapshot", async () => {
  const index = IndexDb.open(":memory:");
  let finish!: (vectors: number[][]) => void;
  const vectors = new Promise<number[][]>(resolve => { finish = resolve; });
  const pending = syncIndex({store:{allForIndex:()=>[ev("same", "Old content")]},index,
    embedConfig:{endpoint:"http://fixture",model:"test"},embedBatch:()=>vectors});
  await syncIndex({store:{allForIndex:()=>[ev("same", "New content")]},index,embedConfig:null});
  finish([[0.1,0.2]]);
  assert.equal((await pending).embedded,0);
  assert.equal(index.getEvent("same")?.summary,"New content");
  assert.equal(index.embedStateFor("same"),undefined);
  index.close();
});
