import assert from "node:assert/strict";
import test from "node:test";
import { eventKitSupportsRecurrence, parseEventKitRecurrence } from "../src/rrule.ts";

test("parses every RFC 5545 component exposed by EKRecurrenceRule", () => {
  assert.deepEqual(parseEventKitRecurrence(
    "RRULE:FREQ=YEARLY;INTERVAL=2;BYDAY=1MO,-1FR;BYMONTHDAY=1,-1;BYMONTH=1,12;BYWEEKNO=1,-1;BYYEARDAY=1,-1;BYSETPOS=1,-1;COUNT=8",
  ), {
    frequency: "YEARLY",
    interval: 2,
    count: 8,
    daysOfWeek: [{ day: "MO", ordinal: 1 }, { day: "FR", ordinal: -1 }],
    daysOfMonth: [1, -1],
    monthsOfYear: [1, 12],
    weeksOfYear: [1, -1],
    daysOfYear: [1, -1],
    setPositions: [1, -1],
  });
});

test("supports date and UTC date-time recurrence ends", () => {
  assert.equal(parseEventKitRecurrence("FREQ=DAILY;UNTIL=20261231").until, "20261231");
  assert.equal(parseEventKitRecurrence("FREQ=DAILY;UNTIL=20261231T225959Z").until, "20261231T225959Z");
});

test("rejects fields EventKit cannot represent instead of dropping semantics", () => {
  for (const rule of [
    "FREQ=DAILY;BYHOUR=9,17",
    "FREQ=WEEKLY;WKST=SU;BYDAY=SU",
    "FREQ=HOURLY;INTERVAL=2",
    "FREQ=DAILY;COUNT=3;UNTIL=20261231",
  ]) {
    assert.equal(eventKitSupportsRecurrence(rule), false, rule);
  }
});

test("rejects duplicates, zeroes and out-of-range values", () => {
  for (const rule of [
    "FREQ=DAILY;FREQ=WEEKLY",
    "FREQ=MONTHLY;BYMONTHDAY=0",
    "FREQ=YEARLY;BYMONTH=13",
    "FREQ=MONTHLY;BYDAY=0MO",
    "FREQ=DAILY;INTERVAL=0",
  ]) assert.throws(() => parseEventKitRecurrence(rule), { name: "Error" }, rule);
});
