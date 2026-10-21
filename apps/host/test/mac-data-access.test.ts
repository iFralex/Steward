import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeLocalData } from "../src/core/mac-data-access.ts";

test("local data health requires a real read and does not report missing data as denied", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "steward-data-access-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(probeLocalData(directory).ok, true);
  const missing = probeLocalData(directory, "Calendar.sqlitedb");
  assert.equal(missing.ok, false);
  assert.equal(missing.verified, false);
  assert.match(missing.detail, /data may be absent/);
  writeFileSync(join(directory, "Calendar.sqlitedb"), "SQLite header");
  assert.equal(probeLocalData(directory, "Calendar.sqlitedb").verified, true);
  mkdirSync(join(directory, "folder"));
  assert.equal(probeLocalData(directory, "folder").ok, false);
});
