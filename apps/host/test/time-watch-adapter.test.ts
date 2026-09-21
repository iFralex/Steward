import assert from "node:assert/strict";
import { test } from "node:test";
import { TimeWatchAdapter, createTimeResourceRef } from "../src/core/time-watch-adapter.ts";

test("time resources require an explicit offset matching the IANA zone", async () => {
  const now = Date.parse("2026-09-21T07:00:00Z");
  const adapter = new TimeWatchAdapter(() => now);
  const resourceRef = createTimeResourceRef("2026-09-21T10:00:00+02:00", "Europe/Rome");
  const snapshot = await adapter.snapshot(resourceRef);
  assert.equal(snapshot.targetTimeMs, Date.parse("2026-09-21T08:00:00Z"));
  assert.throws(() => createTimeResourceRef("2026-09-21T10:00:00+01:00", "Europe/Rome"), /does not match/);
  assert.throws(() => createTimeResourceRef("2026-09-21T10:00:00", "Europe/Rome"), /explicit UTC offset/);
});

test("time adapter emits once when a persisted instant is crossed", async () => {
  let now = Date.parse("2026-09-21T07:59:00Z");
  const adapter = new TimeWatchAdapter(() => now);
  const resourceRef = createTimeResourceRef("2026-09-21T10:00:00+02:00", "Europe/Rome");
  const previous = await adapter.snapshot(resourceRef);
  now = Date.parse("2026-09-21T08:00:03Z");
  const current = await adapter.snapshot(resourceRef);
  const [event] = adapter.events(previous, current);
  assert.equal(event.type, "time.reached");
  assert.equal(event.data.timeZone, "Europe/Rome");
  assert.equal(adapter.events(current, current).length, 0);
});
