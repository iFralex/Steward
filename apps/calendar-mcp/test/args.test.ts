import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchArgs, parseCreateArgs, parseUpdateArgs } from "../src/args.ts";

test("parseSearchArgs defaults the range and limit", () => {
  const a = parseSearchArgs({ query: "dentist" });
  assert.equal(a.query, "dentist");
  assert.equal(a.limit, 10);
  assert.equal(a.offset, 0);
  assert.equal(a.fetchLimit, 11);
  assert.ok(Date.parse(a.start) < Date.parse(a.end));
});

test("parseCreateArgs requires calendar/summary/start/end", () => {
  assert.throws(() => parseCreateArgs({ summary: "x", start: "2026-06-25T10:00:00Z", end: "2026-06-25T11:00:00Z" }), /calendar/);
});

test("parseCreateArgs accepts a stable calendarId without a title", () => {
  const value = parseCreateArgs({ calendarId: "CAL-10", summary: "x", start: "2026-06-25T10:00:00Z", end: "2026-06-25T11:00:00Z" });
  assert.equal(value.calendarId, "CAL-10");
  assert.equal(value.calendar, undefined);
});

test("parseCreateArgs rejects end before start", () => {
  assert.throws(() => parseCreateArgs({ calendar: "Casa", summary: "x", start: "2026-06-25T11:00:00Z", end: "2026-06-25T10:00:00Z" }), /after start/);
});

test("parseCreateArgs accepts a valid alarms array and rejects bad ones", () => {
  const ok = parseCreateArgs({ calendar: "Casa", summary: "x", start: "2026-06-25T10:00:00Z", end: "2026-06-25T11:00:00Z", alarms: [15, 1440] });
  assert.deepEqual(ok.alarms, [15, 1440]);
  const base = { calendar: "Casa", summary: "x", start: "2026-06-25T10:00:00Z", end: "2026-06-25T11:00:00Z" };
  assert.throws(() => parseCreateArgs({ ...base, alarms: [-5] }), /non-negative/);
  assert.throws(() => parseCreateArgs({ ...base, alarms: ["15"] }), /non-negative/);
  assert.throws(() => parseCreateArgs({ ...base, alarms: 15 }), /array/);
});

test("calendar date inputs require an explicit timezone", () => {
  const base = { calendar: "Casa", summary: "x", end: "2026-06-25T11:00:00Z" };
  assert.throws(() => parseCreateArgs({ ...base, start: "2026-06-25T10:00:00" }), /explicit timezone/);
  assert.throws(() => parseCreateArgs({ ...base, start: "2026-06-25" }), /explicit timezone/);
  assert.throws(() => parseSearchArgs({ start: "2026-06-25T00:00:00", end: "2026-06-26T00:00:00Z" }), /explicit timezone/);
  assert.throws(() => parseUpdateArgs({ uid: "U1", start: "2026-06-25T10:00:00" }), /explicit timezone/);
});

test("calendar date inputs are normalized to UTC", () => {
  const created = parseCreateArgs({
    calendar: "Casa",
    summary: "x",
    start: "2026-06-25T10:00:00+02:00",
    end: "2026-06-25T11:30:00+02:00",
  });
  assert.equal(created.start, "2026-06-25T08:00:00.000Z");
  assert.equal(created.end, "2026-06-25T09:30:00.000Z");

  const updated = parseUpdateArgs({ uid: "U1", start: "2026-12-25T10:00:00+01:00" });
  assert.equal(updated.start, "2026-12-25T09:00:00.000Z");
});
