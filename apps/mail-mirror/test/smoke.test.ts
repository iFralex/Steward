import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";

test("better-sqlite3 opens with WAL and FTS5 is available", () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
  db.prepare("INSERT INTO t(body) VALUES (?)").run("frecciarossa roma milano");
  const row = db.prepare("SELECT body FROM t WHERE t MATCH ?").get("roma") as { body: string };
  assert.ok(row.body.includes("frecciarossa"));
  db.close();
});
