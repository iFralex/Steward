import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreate, buildUpdate, buildDelete, mapCalendarError, createEvent } from "../src/applescript.ts";

test("buildCreate sets calendar, summary and escapes quotes", () => {
  const s = buildCreate({ calendar: "Casa", summary: 'a"b', start: "2026-06-25T10:00:00.000Z", end: "2026-06-25T11:00:00.000Z" });
  assert.match(s, /calendar "Casa"/);
  assert.match(s, /summary:"a\\"b"/);
  assert.match(s, /make new event/);
});

test("buildCreate adds display alarms as minutes-before (negative trigger interval)", () => {
  const s = buildCreate({ calendar: "Casa", summary: "x", start: "2026-06-25T10:00:00.000Z", end: "2026-06-25T11:00:00.000Z", alarms: [15, 1440] });
  assert.match(s, /make new display alarm at end of display alarms of e with properties \{trigger interval:-15\}/);
  assert.match(s, /\{trigger interval:-1440\}/);
});

test("buildCreate adds no alarm lines when alarms is omitted", () => {
  const s = buildCreate({ calendar: "Casa", summary: "x", start: "2026-06-25T10:00:00.000Z", end: "2026-06-25T11:00:00.000Z" });
  assert.doesNotMatch(s, /display alarm/);
});

test("buildUpdate replaces alarms (deletes existing, adds new); [] clears all", () => {
  const s = buildUpdate({ uid: "U1", alarms: [30] });
  assert.match(s, /delete \(every display alarm of theEvent\)/);
  assert.match(s, /make new display alarm at end of display alarms of theEvent with properties \{trigger interval:-30\}/);
  const cleared = buildUpdate({ uid: "U1", alarms: [] });
  assert.match(cleared, /delete \(every display alarm of theEvent\)/);
  assert.doesNotMatch(cleared, /make new display alarm/);
  const untouched = buildUpdate({ uid: "U1", summary: "y" });
  assert.doesNotMatch(untouched, /display alarm/);
});

test("buildDelete locates by uid", () => {
  assert.match(buildDelete("UID-9"), /whose uid is "UID-9"/);
});

test("mapCalendarError explains automation denial", () => {
  assert.match(mapCalendarError("-1743 Not authorized"), /Automation/);
});

test("createEvent returns the uid printed by the script", async () => {
  const uid = await createEvent(
    { calendar: "Casa", summary: "x", start: "2026-06-25T10:00:00.000Z", end: "2026-06-25T11:00:00.000Z" },
    async () => "UID-NEW\n",
  );
  assert.equal(uid, "UID-NEW");
});
