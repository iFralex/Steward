import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import type { CalEvent } from "../src/types.ts";

function ev(uid: string, summary: string): CalEvent {
  return { uid, summary, description: null, location: null, start: "2026-06-25T10:00:00.000Z",
    end: "2026-06-25T11:00:00.000Z", allDay: false, calendarId: "CAL-1", calendar: "Casa", account: "iCloud",
    alarms: [], hasRecurrence: false, status: 1, url: null, lastModified: 1 };
}

function evf(uid: string, summary: string, account: string, start: string): CalEvent {
  return { uid, summary, description: null, location: null, start, end: start,
    allDay: false, calendarId: `CAL-${account}`, calendar: "Casa", account,
    alarms: [], hasRecurrence: false, status: 1, url: null, lastModified: 1 };
}

test("allowedUids returns null for an empty filter and a set for an account filter", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(evf("U1", "a", "A", "2026-06-25T10:00:00.000Z"), "h1");
  db.upsertEvent(evf("U2", "b", "B", "2026-06-25T10:00:00.000Z"), "h2");
  assert.equal(db.allowedUids({}), null);
  assert.deepEqual([...(db.allowedUids({ account: "A" }) ?? [])], ["U1"]);
  db.close();
});

test("allowedUids filters by start-date range", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(evf("U1", "a", "A", "2026-01-01T00:00:00.000Z"), "h1");
  db.upsertEvent(evf("U2", "b", "A", "2026-12-01T00:00:00.000Z"), "h2");
  const set = db.allowedUids({ startISO: "2026-06-01T00:00:00.000Z", endISO: "2027-01-01T00:00:00.000Z" });
  assert.deepEqual([...(set ?? [])], ["U2"]);
  db.close();
});

test("ftsSearch respects an account filter", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(evf("U1", "alpha", "A", "2026-06-25T10:00:00.000Z"), "h1");
  db.upsertEvent(evf("U2", "alpha", "B", "2026-06-25T10:00:00.000Z"), "h2");
  assert.deepEqual(db.ftsSearch('"alpha"', 10, { account: "A" }), ["U1"]);
  db.close();
});

test("upsert + FTS finds by summary token", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(ev("U1", "Dentist appointment"), "h1");
  db.upsertEvent(ev("U2", "Team standup"), "h2");
  assert.deepEqual(db.ftsSearch("dentist", 10), ["U1"]);
  db.close();
});

test("getEvent round-trips write-confirmation metadata", () => {
  const db = IndexDb.open(":memory:");
  const input: CalEvent = {
    ...ev("U1", "Recurring lesson"),
    allDay: true,
    calendarId: "CAL-WORK",
    alarms: [10, 60],
    hasRecurrence: true,
  };
  db.upsertEvent(input, "h1");
  assert.deepEqual(db.getEvent("U1"), { ...input, refId: db.refIdForUid("U1") });
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

test("full-sync UUID replacement preserves identity and resolves the stale UUID", () => {
  const db = IndexDb.open(":memory:");
  const before = { ...ev("OLD-UUID", "Dentist"), externalId: "server-event-1" };
  db.upsertEvent(before, "h1", 1);
  db.recordEmbed("OLD-UUID", "h1", 3, "local-embed");

  const after = { ...before, uid: "NEW-UUID", calendarId: "NEW-CALENDAR-UUID" };
  db.upsertEvent(after, "h1", 2);

  assert.deepEqual(db.allUids(), ["NEW-UUID"]);
  assert.equal(db.resolveUid("OLD-UUID"), "NEW-UUID");
  assert.equal(db.resolveUid("NEW-UUID"), "NEW-UUID");
  assert.equal(db.embedStateFor("NEW-UUID")?.sourceHash, "h1");
  db.close();
});

test("duplicate external identifiers do not cause an ambiguous UUID rebind", () => {
  const db = IndexDb.open(":memory:");
  const first = { ...ev("OLD-1", "Duplicate"), externalId: "shared-server-id" };
  const second = { ...first, uid: "OLD-2" };
  db.upsertEvent(first, "h1", 1);
  db.upsertEvent(second, "h2", 1);

  // Same server id/calendar/start is intentionally ambiguous. A third local
  // UUID must remain a distinct event rather than hijacking either reference.
  db.upsertEvent({ ...first, uid: "NEW-3" }, "h3", 2);
  assert.deepEqual(db.allUids().sort(), ["NEW-3", "OLD-1", "OLD-2"]);
  assert.equal(db.resolveUid("OLD-1"), "OLD-1");
  assert.equal(db.resolveUid("OLD-2"), "OLD-2");
  db.close();
});
