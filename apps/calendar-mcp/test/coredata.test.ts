import assert from "node:assert/strict";
import { test } from "node:test";
import { coreDataToUnix, unixToCoreData, coreDataToISO, isoToUnix } from "../src/coredata.ts";

test("Core Data <-> Unix offset is 978307200", () => {
  assert.equal(coreDataToUnix(0), 978307200);
  assert.equal(unixToCoreData(978307200), 0);
});

test("coreDataToISO renders a known instant", () => {
  // 2001-01-01T00:00:00Z is Core Data 0
  assert.equal(coreDataToISO(0), "2001-01-01T00:00:00.000Z");
});

test("isoToUnix parses ISO to unix seconds", () => {
  assert.equal(isoToUnix("2001-01-01T00:00:00.000Z"), 978307200);
});
