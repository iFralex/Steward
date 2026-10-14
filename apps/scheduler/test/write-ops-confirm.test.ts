import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  calendarFieldsMatch,
  findCalendarConfirmation,
  findMailConfirmation,
  shouldExhaustCalendarConfirmation,
  shouldExhaustMailConfirmation,
} from "../src/write-ops-cli.ts";
import { IndexDb } from "../../calendar-mcp/src/index-db.ts";

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

test("mail confirmations are bounded when the mirror never observes the write", () => {
  assert.equal(shouldExhaustMailConfirmation(11), false);
  assert.equal(shouldExhaustMailConfirmation(12), true);
});

test("calendar confirmation checks target, all-day state, alarms and recurrence presence", () => {
  const actual = {
    calendarId: "CAL-1",
    calendar: "Work",
    summary: "Demo",
    start: "2026-10-14T09:30:00.000Z",
    end: "2026-10-14T10:00:00.000Z",
    allDay: false,
    alarms: [60, 10],
    hasRecurrence: true,
  };
  const expected = {
    calendarId: "CAL-1",
    summary: "Demo",
    start: "2026-10-14T09:30:00.000Z",
    end: "2026-10-14T10:00:00.000Z",
    allDay: false,
    alarms: [10, 60],
    recurrence: "FREQ=WEEKLY",
  };
  assert.equal(calendarFieldsMatch(actual, expected), true);
  assert.equal(calendarFieldsMatch({ ...actual, calendarId: "CAL-2" }, expected), false);
  assert.equal(calendarFieldsMatch({ ...actual, allDay: true }, expected), false);
  assert.equal(calendarFieldsMatch({ ...actual, alarms: [10] }, expected), false);
  assert.equal(calendarFieldsMatch({ ...actual, hasRecurrence: false }, expected), false);
});

test("calendar confirmation compares all-day boundaries by civil date across DST", () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "Europe/Rome";
  try {
    const base = {
      uid: "A1",
      summary: "DST weekend",
      calendarId: "CAL-1",
      allDay: true,
      alarms: [],
      hasRecurrence: false,
    };

    // SQLite commonly exposes UTC-midnight dates, while an EventKit request
    // uses local midnight. These are the same civil days around DST start.
    assert.equal(calendarFieldsMatch({
      ...base,
      start: "2026-03-29T00:00:00.000Z",
      end: "2026-03-31T00:00:00.000Z",
    }, {
      summary: "DST weekend",
      calendarId: "CAL-1",
      allDay: true,
      start: "2026-03-28T23:00:00.000Z",
      end: "2026-03-30T22:00:00.000Z",
    }), true);

    // A genuine one-day displacement must not be accepted.
    assert.equal(calendarFieldsMatch({
      ...base,
      start: "2026-03-30T00:00:00.000Z",
      end: "2026-04-01T00:00:00.000Z",
    }, {
      summary: "DST weekend",
      calendarId: "CAL-1",
      allDay: true,
      start: "2026-03-28T23:00:00.000Z",
      end: "2026-03-30T22:00:00.000Z",
    }), false);
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("a create saved before a crash is recovered uniquely without a returned uid", () => {
  const index = IndexDb.open(":memory:");
  const event = {
    uid: "EVENT-1", externalId: "SERVER-1", summary: "Crash recovery",
    description: null, location: null, start: "2026-12-01T10:00:00.000Z", end: "2026-12-01T11:00:00.000Z",
    allDay: false, calendarId: "CAL-1", calendar: "Work", account: "iCloud",
    alarms: [], hasRecurrence: false, status: 1, url: null, lastModified: 1,
  };
  index.upsertEvent(event, "h1");
  const op = {
    kind: "calendar.create", result: null, input: {},
    expected: { summary: event.summary, start: event.start, end: event.end, calendarId: event.calendarId, allDay: false },
  } as any;
  assert.equal(findCalendarConfirmation(index, op), "EVENT-1");

  index.upsertEvent({ ...event, uid: "EVENT-2", externalId: "SERVER-2" }, "h2");
  assert.equal(findCalendarConfirmation(index, op), null, "identical candidates must remain ambiguous");
  index.close();
});

test("failed creates without a returned uid are terminal and confirmations are bounded", () => {
  const base = {
    id: "op", kind: "calendar.create", status: "failed", attempts: 1, confirmAttempts: 0,
    startedAt: 1, updatedAt: 1, scriptFinishedAt: 1, confirmedAt: null, scheduledFor: null,
    lastError: "deterministic failure", result: null, input: {}, expected: {},
  } as any;
  assert.equal(shouldExhaustCalendarConfirmation(base), true);
  assert.equal(shouldExhaustCalendarConfirmation({ ...base, kind: "calendar.update", input: { uid: "U1" }, confirmAttempts: 10 }), false);
  assert.equal(shouldExhaustCalendarConfirmation({ ...base, kind: "calendar.update", input: { uid: "U1" }, confirmAttempts: 11 }), true);
});
