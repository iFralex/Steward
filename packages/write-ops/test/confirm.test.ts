import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { findMailConfirmation } from "../src/cli.ts";

function mailStoreWith(body: string) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (message_id TEXT, date INTEGER, mailbox TEXT, deleted INTEGER, from_addr TEXT, subject TEXT, body_text TEXT)`);
  db.prepare(`INSERT INTO messages VALUES ('m1', ?, 'Sent', 0, 'me@x.com', 'Subj', ?)`).run(Math.floor(Date.now() / 1000), body);
  return { raw: db, close: () => db.close() } as any;
}

test("confirmation matches a body snippet containing underscores", () => {
  const body = "ecco la mia_variabile importante nel testo";
  const store = mailStoreWith(body);
  const op = {
    startedAt: Math.floor(Date.now() / 1000) - 10,
    expected: { bodySnippet: "ecco la mia_variabile importante", from: "me@x.com", subject: "Subj" },
  } as any;
  assert.ok(findMailConfirmation(store, op), "snippet with _ must match");
});
