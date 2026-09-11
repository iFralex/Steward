import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IndexDb } from "../../calendar-mcp/src/index-db.ts";
import { ActionStore } from "../src/store.ts";
import { scanCalendarForActions } from "../src/calendar.ts";
import { unixToCoreData } from "../../calendar-mcp/src/coredata.ts";

test("scanCalendarForActions creates reminders for upcoming events", () => {
  const dir = mkdtempSync(join(tmpdir(), "action-center-cal-"));
  const calPath = join(dir, "calendar.db");
  const cal = IndexDb.open(calPath);
  cal.upsertEvent({
    uid: "u1",
    summary: "Colloquio",
    description: null,
    location: "Meet",
    start: "2026-06-27T10:00:00.000Z",
    end: "2026-06-27T11:00:00.000Z",
    allDay: false,
    calendar: "Work",
    account: "iCloud",
    status: 1,
    url: null,
    lastModified: 1,
  }, "h1");
  cal.close();

  const actions = ActionStore.open(":memory:");
  const res = scanCalendarForActions({
    actions,
    calendarDbPath: calPath,
    now: new Date("2026-06-26T10:00:00.000Z"),
    horizonDays: 3,
  });
  assert.equal(res.created, 1);
  const item = actions.list()[0];
  assert.equal(item.kind, "event-reminder");
  assert.equal(item.priority, "high");
  assert.equal(item.payload.uid, "u1");
  actions.close();
});

test("scanCalendarForActions ignores events not modified after a re-enable cutoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "action-center-cal-cutoff-"));
  const calPath = join(dir, "calendar.db");
  const cal = IndexDb.open(calPath);
  const cutoff = Math.floor(new Date("2026-06-26T10:00:00.000Z").getTime() / 1000);
  for (const [uid, lastModified] of [["old", cutoff - 10], ["new", cutoff + 10]] as const) {
    cal.upsertEvent({
      uid,
      summary: uid,
      description: null,
      location: null,
      start: "2026-06-27T10:00:00.000Z",
      end: "2026-06-27T11:00:00.000Z",
      allDay: false,
      calendar: "Work",
      account: "iCloud",
      status: 1,
      url: null,
      lastModified: unixToCoreData(lastModified),
    }, uid);
  }
  cal.close();

  const actions = ActionStore.open(":memory:");
  const res = scanCalendarForActions({
    actions,
    calendarDbPath: calPath,
    now: new Date("2026-06-26T10:00:00.000Z"),
    horizonDays: 3,
    modifiedAfter: cutoff,
  });
  assert.equal(res.created, 1);
  assert.equal(actions.list()[0].payload.uid, "new");
  actions.close();
});
