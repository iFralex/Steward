// apps/mail-mcp/test/capabilities.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Store } from "../../mail-mirror/src/store.ts";
import { enrichmentReady } from "../src/capabilities.ts";

test("enrichmentReady is true for a migrated (fresh) Store", () => {
  const s = Store.open(":memory:"); // fresh open runs full SCHEMA + migrate
  assert.equal(enrichmentReady(s), true);
  s.close();
});

test("enrichmentReady is false for a pre-enrichment DB", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (message_id TEXT PRIMARY KEY, account TEXT, mailbox TEXT, subject TEXT, body_text TEXT, deleted INTEGER DEFAULT 0)`);
  // Open read-only so the constructor does NOT migrate (mirrors mail-mcp usage).
  const ro = new Store(db, { readonly: true } as never);
  assert.equal(enrichmentReady(ro), false);
  ro.close();
});
