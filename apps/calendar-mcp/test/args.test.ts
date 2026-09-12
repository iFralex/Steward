import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchArgs, parseCreateArgs } from "../src/args.ts";

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
