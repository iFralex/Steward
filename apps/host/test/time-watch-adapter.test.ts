import assert from "node:assert/strict";
import { test } from "node:test";
import { TimeWatchAdapter, createTimeResourceRef } from "../src/core/time-watch-adapter.ts";

test("time resources follow the calendar convention: explicit offset normalized to UTC", async () => {
  const now = Date.parse("2026-09-21T07:00:00Z");
  const adapter = new TimeWatchAdapter(() => now);
  const resourceRef = createTimeResourceRef("2026-09-21T10:00:00+02:00");
  const snapshot = await adapter.snapshot(resourceRef);
  assert.equal(snapshot.targetTimeMs, Date.parse("2026-09-21T08:00:00Z"));
  assert.match(resourceRef, /2026-09-21T08:00:00\.000Z/);
  assert.throws(() => createTimeResourceRef("2026-09-21T10:00:00"), /explicit UTC offset/);
});

test("time adapter emits once when a persisted instant is crossed", async () => {
  let now = Date.parse("2026-09-21T07:59:00Z");
  const adapter = new TimeWatchAdapter(() => now);
  const previousTz = process.env.TZ;
  process.env.TZ = "Europe/Rome";
  try {
    const resourceRef = createTimeResourceRef("2026-09-21T10:00:00+02:00");
    const previous = await adapter.snapshot(resourceRef);
    now = Date.parse("2026-09-21T08:00:03Z");
    const current = await adapter.snapshot(resourceRef);
    const [event] = adapter.events(previous, current);
    assert.equal(event.type, "time.reached");
    assert.equal(event.data.timeZone, "Europe/Rome");
    assert.equal(event.data.scheduledAt, "2026-09-21T10:00:00+02:00");
    assert.equal(adapter.events(current, current).length, 0);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});
