// apps/mail-mirror/test/store-migrate.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Store } from "../src/store.ts";

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
}

test("fresh DB has the new columns and tables", () => {
  const s = Store.open(":memory:");
  const cols = columns(s.raw, "messages");
  for (const c of ["answered", "junk", "flag_color", "apple_thrid", "to_names", "cc_names"]) {
    assert.ok(cols.has(c), `messages.${c} missing`);
  }
  const tables = new Set(
    (s.raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]).map((r) => r.name),
  );
  assert.ok(tables.has("accounts"));
  assert.ok(tables.has("mailbox_roles"));
  assert.ok(tables.has("messages_trig"));
  s.close();
});

test("an old DB missing the new columns is migrated in place", () => {
  const db = new Database(":memory:");
  // Simulate the pre-enrichment messages table (subset of old columns).
  db.exec(`CREATE TABLE messages (
    message_id TEXT PRIMARY KEY, account TEXT NOT NULL, mailbox TEXT,
    from_name TEXT, from_addr TEXT, to_addrs TEXT, cc_addrs TEXT,
    subject TEXT, date INTEGER, snippet TEXT, body_text TEXT,
    body_state TEXT NOT NULL, source TEXT NOT NULL, emlx_path TEXT,
    in_reply_to TEXT, reference_ids TEXT, gm_thrid TEXT, thread_id INTEGER,
    flagged INTEGER DEFAULT 0, unread INTEGER DEFAULT 0, size INTEGER,
    deleted INTEGER DEFAULT 0, ingested_at INTEGER, updated_at INTEGER);`);
  db.exec("INSERT INTO messages(message_id,account,body_state,source) VALUES ('m1','ACC','full','emlx')");
  const s = new Store(db); // non-readonly → migrates
  const cols = columns(s.raw, "messages");
  assert.ok(cols.has("apple_thrid") && cols.has("to_names"));
  assert.equal((s.raw.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c, 1);
  s.close();
});
