import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyPath } from "../src/core/migrate.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "migrate-"));
}

test("moves a legacy dir (with contents) to the new path when the new path is absent", () => {
  const root = tmp();
  const legacy = join(root, "llmwiki-chats");
  mkdirSync(join(legacy, "sessions"), { recursive: true });
  writeFileSync(join(legacy, "chats.db"), "DATA");
  const current = join(root, "steward-chats");

  migrateLegacyPath(legacy, current);

  assert.equal(existsSync(legacy), false, "legacy dir moved away");
  assert.equal(readFileSync(join(current, "chats.db"), "utf8"), "DATA", "contents preserved");
  assert.equal(existsSync(join(current, "sessions")), true, "subdir preserved");
  rmSync(root, { recursive: true, force: true });
});

test("no-op (and never deletes) when the new path already exists", () => {
  const root = tmp();
  const legacy = join(root, "llmwiki-usage");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "usage.db"), "OLD");
  const current = join(root, "steward-usage");
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, "usage.db"), "NEW");

  migrateLegacyPath(legacy, current);

  assert.equal(readFileSync(join(current, "usage.db"), "utf8"), "NEW", "new data untouched");
  assert.equal(existsSync(legacy), true, "legacy NOT deleted when new exists");
  rmSync(root, { recursive: true, force: true });
});

test("no-op when there is no legacy path (fresh install)", () => {
  const root = tmp();
  const current = join(root, "steward-chats");
  migrateLegacyPath(join(root, "llmwiki-chats"), current);
  assert.equal(existsSync(current), false, "does not create anything on a fresh install");
  rmSync(root, { recursive: true, force: true });
});

test("migrates a single legacy file, creating the new parent dir", () => {
  const root = tmp();
  const legacy = join(root, "llm-wiki", "contacts-index.sqlitedb");
  mkdirSync(join(root, "llm-wiki"), { recursive: true });
  writeFileSync(legacy, "IDX");
  const current = join(root, "steward", "contacts-index.sqlitedb");

  migrateLegacyPath(legacy, current);

  assert.equal(readFileSync(current, "utf8"), "IDX", "file moved + parent created");
  assert.equal(existsSync(legacy), false, "legacy file moved away");
  rmSync(root, { recursive: true, force: true });
});
