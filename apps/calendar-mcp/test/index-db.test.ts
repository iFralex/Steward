import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import type { CalEvent } from "../src/types.ts";

function ev(uid: string, summary: string): CalEvent {
  return { uid, summary, description: null, location: null, start: "2026-06-25T10:00:00.000Z",
    end: "2026-06-25T11:00:00.000Z", allDay: false, calendar: "Casa", account: "iCloud", status: 1, url: null, lastModified: 1 };
}

test("upsert + FTS finds by summary token", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(ev("U1", "Dentist appointment"), "h1");
  db.upsertEvent(ev("U2", "Team standup"), "h2");
  assert.deepEqual(db.ftsSearch("dentist", 10), ["U1"]);
  db.close();
});

test("deleteMissing removes uids not in the keep list", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(ev("U1", "a"), "h1");
  db.upsertEvent(ev("U2", "b"), "h2");
  assert.equal(db.deleteMissing(["U1"]), 1);
  assert.deepEqual(db.allUids().sort(), ["U1"]);
  db.close();
});

test("embed bookkeeping round-trips", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(ev("U1", "a"), "h1");
  assert.equal(db.embedStateFor("U1"), undefined);
  db.recordEmbed("U1", "h1", 3, "local-embed");
  assert.equal(db.embedStateFor("U1")?.sourceHash, "h1");
  db.close();
});
