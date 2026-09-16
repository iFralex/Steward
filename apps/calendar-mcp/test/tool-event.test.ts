import assert from "node:assert/strict";
import { test } from "node:test";
import { toLocalRfc3339 } from "../src/tool-event.ts";

test("tool events render the Calendar.app wall-clock time with the date-specific offset", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Europe/Rome";
  try {
    assert.equal(toLocalRfc3339("2026-09-28T06:15:00.000Z"), "2026-09-28T08:15:00+02:00");
    assert.equal(toLocalRfc3339("2026-10-26T07:15:00.000Z"), "2026-10-26T08:15:00+01:00");
    assert.equal(Date.parse(toLocalRfc3339("2026-09-28T06:15:00.000Z")), Date.parse("2026-09-28T06:15:00.000Z"));
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
