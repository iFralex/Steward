import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromoteState } from "../src/state.ts";
import { migratePromotedThreadNotes } from "../src/migrate-thread-notes.ts";

test("migration renames existing promoted notes and changes only wiki_filename", () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-notes-"));
  const state = PromoteState.open(":memory:");
  state.record({
    messageId: "thread:12", decision: "promoted", categories: ["decision"],
    classifyModel: "tier-5", distillModel: "tier-5",
    wikiFilename: "mail-last-message.md", sourceHash: "hash-12",
  });
  writeFileSync(join(dir, "mail-last-message.md"), "distilled content");

  const r = migratePromotedThreadNotes(state, dir);

  assert.equal(r.migrated, 1);
  assert.equal(existsSync(join(dir, "mail-last-message.md")), false);
  assert.equal(readFileSync(join(dir, "mail-thread-12.md"), "utf8"), "distilled content");
  const saved = state.getRecord("thread:12");
  assert.equal(saved?.wikiFilename, "mail-thread-12.md");
  assert.equal(saved?.sourceHash, "hash-12");
  assert.equal(saved?.decision, "promoted");
  state.close();
});

test("migration does not overwrite a conflicting canonical note", () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-notes-"));
  const state = PromoteState.open(":memory:");
  state.record({
    messageId: "thread:13", decision: "promoted", categories: [],
    classifyModel: "tier-5", distillModel: "tier-5",
    wikiFilename: "mail-old.md", sourceHash: "h",
  });
  writeFileSync(join(dir, "mail-old.md"), "old content");
  writeFileSync(join(dir, "mail-thread-13.md"), "different content");

  const r = migratePromotedThreadNotes(state, dir);

  assert.equal(r.conflicts, 1);
  assert.equal(state.getRecord("thread:13")?.wikiFilename, "mail-old.md");
  assert.equal(readFileSync(join(dir, "mail-thread-13.md"), "utf8"), "different content");
  state.close();
});

test("migration keeps the newest note when legacy duplicates share a thread", () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-notes-"));
  const state = PromoteState.open(":memory:");
  state.record({
    messageId: "thread:14", decision: "promoted", categories: [],
    classifyModel: "tier-5", distillModel: "tier-5",
    wikiFilename: "mail-thread-14.md", sourceHash: "h",
  });
  writeFileSync(join(dir, "mail-thread-14.md"), "---\nthread: thread://14\ndate: 2026-01-01T00:00:00Z\n---\nold");
  writeFileSync(join(dir, "mail-new-message.md"), "---\nthread: thread://14\ndate: 2026-02-01T00:00:00Z\n---\nnew");
  writeFileSync(join(dir, "mail-old-message.md"), "---\nthread: thread://14\ndate: 2025-12-01T00:00:00Z\n---\noldest");

  const r = migratePromotedThreadNotes(state, dir);

  assert.equal(r.canonicalNotesReplaced, 1);
  assert.equal(r.duplicateNotesRemoved, 1);
  assert.match(readFileSync(join(dir, "mail-thread-14.md"), "utf8"), /\nnew$/);
  assert.equal(existsSync(join(dir, "mail-new-message.md")), false);
  assert.equal(existsSync(join(dir, "mail-old-message.md")), false);
  state.close();
});
