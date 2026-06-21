import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreate, buildDelete, mapCalendarError, createEvent } from "../src/applescript.ts";

test("buildCreate sets calendar, summary and escapes quotes", () => {
  const s = buildCreate({ calendar: "Casa", summary: 'a"b', start: "2026-06-25T10:00:00.000Z", end: "2026-06-25T11:00:00.000Z" });
  assert.match(s, /calendar "Casa"/);
  assert.match(s, /summary:"a\\"b"/);
  assert.match(s, /make new event/);
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
