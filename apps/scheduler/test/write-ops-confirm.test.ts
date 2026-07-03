import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { findMailConfirmation } from "../src/write-ops-cli.ts";

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

test("falls back to from+subject+date when the body snippet is not in the mirror", () => {
  const store = mailStoreWith("(body stored as html, snippet absent)");
  const op = {
    startedAt: Math.floor(Date.now() / 1000) - 10,
    expected: { bodySnippet: "text the mirror never stored", from: "me@x.com", subject: "Subj" },
  } as any;
  assert.ok(findMailConfirmation(store, op), "must fall back to subject+from match");
});

function storeWithRows(rows: { body?: string; from?: string; subject?: string; date: number }[]) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (message_id TEXT, date INTEGER, mailbox TEXT, deleted INTEGER, from_addr TEXT, subject TEXT, body_text TEXT)`);
  let i = 0;
  for (const r of rows) db.prepare(`INSERT INTO messages VALUES (?, ?, 'Sent', 0, ?, ?, ?)`).run(`m${i++}`, r.date, r.from ?? "me@x.com", r.subject ?? "Subj", r.body ?? "");
  return { raw: db, close: () => db.close() } as any;
}

test("fallback does NOT confirm against a pre-existing message dated before the send attempt", () => {
  const now = Math.floor(Date.now() / 1000);
  const store = storeWithRows([{ date: now - 200, subject: "Subj", from: "me@x.com" }]); // older than startedAt
  const op = { startedAt: now, expected: { bodySnippet: "text not in mirror", from: "me@x.com", subject: "Subj" } } as any;
  assert.equal(findMailConfirmation(store, op), null, "a message older than the send must not confirm it");
});

test("fallback confirms a message that lands just after the send attempt", () => {
  const now = Math.floor(Date.now() / 1000);
  const store = storeWithRows([{ date: now + 5, subject: "Subj", from: "me@x.com" }]);
  const op = { startedAt: now, expected: { bodySnippet: "text not in mirror", from: "me@x.com", subject: "Subj" } } as any;
  assert.ok(findMailConfirmation(store, op), "the send that landed just after must confirm");
});

test("fallback does NOT confirm a same-subject message far in the future (recurring subject)", () => {
  const now = Math.floor(Date.now() / 1000);
  const store = storeWithRows([{ date: now + 3 * 86400, subject: "Subj", from: "me@x.com" }]);
  const op = { startedAt: now, expected: { bodySnippet: "text not in mirror", from: "me@x.com", subject: "Subj" } } as any;
  assert.equal(findMailConfirmation(store, op), null, "a much later same-subject message must not confirm this send");
});

test("fallback picks the EARLIEST matching message after the send (not a later same-subject one)", () => {
  const now = Math.floor(Date.now() / 1000);
  const store = storeWithRows([
    { date: now + 5, subject: "Subj", from: "me@x.com", body: "the real send" },
    { date: now + 4000, subject: "Subj", from: "me@x.com", body: "a later same-subject email" },
  ]);
  const op = { startedAt: now, expected: { bodySnippet: "text not in mirror", from: "me@x.com", subject: "Subj" } } as any;
  const row = findMailConfirmation(store, op);
  assert.equal(row?.message_id, "m0", "must pick the earliest post-send match");
});

test("fallback never fires for a reply (no subject in expected)", () => {
  const now = Math.floor(Date.now() / 1000);
  const store = storeWithRows([{ date: now + 5, subject: "Subj", from: "me@x.com" }]);
  const op = { startedAt: now, expected: { bodySnippet: "text not in mirror", from: "me@x.com" } } as any; // reply: no subject
  assert.equal(findMailConfirmation(store, op), null, "replies must not use the header fallback");
});
