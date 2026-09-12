import assert from "node:assert/strict";
import test from "node:test";
import { buildEventSearchPage } from "../src/event-page.ts";
import type { CalEvent } from "../src/types.ts";

const event = (index: number): CalEvent => ({
  uid: `event-${index}`,
  summary: `Event ${index}`,
  description: `${index}: ${"x".repeat(500)}`,
  location: "Room",
  start: new Date(1_800_000_000_000 + index * 3_600_000).toISOString(),
  end: new Date(1_800_000_000_000 + (index + 1) * 3_600_000).toISOString(),
  allDay: false,
  calendar: "Work",
  account: "Account",
  status: 1,
  url: `https://calendar.example/${index}`,
  lastModified: 1_800_000_000 + index,
});

test("returns a page with a continuation offset", () => {
  const page = buildEventSearchPage(Array.from({ length: 11 }, (_, i) => event(i)), 10, 20);
  assert.equal(page.events.length, 10);
  assert.deepEqual(page.page, { offset: 20, returned: 10, hasMore: true, nextOffset: 30 });
});

test("keeps actionable event metadata and compacts only descriptions", () => {
  const page = buildEventSearchPage(Array.from({ length: 5 }, (_, i) => event(i)), 10, 0);
  assert.equal(page.events[0].uid, "event-0");
  assert.equal(page.events[0].url, "https://calendar.example/0");
  assert.equal(page.events[0].calendar, "Work");
  assert.equal(page.events[0].start, event(0).start);
  assert.ok((page.events[0].description?.length ?? 0) <= 300);
  assert.ok((page.events[2].description?.length ?? 0) <= 300);
  assert.ok((page.events[3].description?.length ?? 0) <= 120);
  assert.deepEqual(page.page, { offset: 0, returned: 5, hasMore: false });
});
