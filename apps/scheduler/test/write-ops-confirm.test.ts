import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarFieldsMatch,
  findCalendarConfirmation,
  findMailConfirmation,
  shouldExhaustCalendarConfirmation,
  shouldExhaustMailConfirmation,
} from "../src/write-ops-cli.ts";
import { IndexDb } from "../../calendar-mcp/src/index-db.ts";

import { Store } from '../../mail-mirror/src/store.ts';

function mailFixture(rows: Record<string, unknown>[] = [{}]) {
  const store = Store.open(':memory:');
  store.raw.exec(`INSERT INTO accounts VALUES ('a1','Main','me@x.com');
    INSERT INTO accounts VALUES ('a2','Other','other@x.com');
    INSERT INTO mailbox_roles VALUES ('a1','Sent','sent');
    INSERT INTO mailbox_roles VALUES ('a2','Sent','sent');`);
  for (const [i, input] of rows.entries()) {
    const row = { id: `m${i}`, account: 'a1', mailbox: 'Sent', date: Math.floor(Date.now()/1000),
      from: 'me@x.com', to: '["you@x.com"]', cc: '[]', subject: 'Subj', body: 'exact outgoing body', ...input };
    store.raw.prepare(`INSERT INTO messages(message_id,account,mailbox,date,from_addr,to_addrs,cc_addrs,subject,body_text,body_state,source)
      VALUES (@id,@account,@mailbox,@date,@from,@to,@cc,@subject,@body,'full','emlx')`).run(row);
  }
  return store;
}
function mailOperation(extra = {}) {
  return { kind: 'mail.send', startedAt: Math.floor(Date.now()/1000)-10,
    input: { to: ['you@x.com'], body: 'exact outgoing body' },
    expected: { from: 'me@x.com', account: 'a1', subject: 'Subj', to: ['you@x.com'], cc: [] }, ...extra } as any;
}

test('confirms one exact sent message with sender/account/recipients/body evidence', () => {
  const store = mailFixture();
  assert.equal(findMailConfirmation(store, mailOperation())?.message_id, 'm0');
  store.close();
});
for (const [name, row] of Object.entries({
  recipient: { to: '["wrong@x.com"]' }, account: { account: 'a2', from: 'other@x.com' },
  folder: { mailbox: 'Inbox' }, body: { body: 'same prefix but different message' },
  cc: { cc: '["unexpected@x.com"]' }, old: { date: Math.floor(Date.now()/1000)-1000 },
})) test(`does not confirm a mismatched ${name}`, () => {
  const store = mailFixture([row]);
  assert.equal(findMailConfirmation(store, mailOperation()), null); store.close();
});
test('ambiguous identical sent messages remain unconfirmed', () => {
  const store = mailFixture([{}, {}]);
  assert.equal(findMailConfirmation(store, mailOperation()), null); store.close();
});
test('scheduled confirmation uses actual attempt time rather than enqueue time', () => {
  const store = mailFixture();
  assert.ok(findMailConfirmation(store, mailOperation({ startedAt: 1, attemptedAt: Math.floor(Date.now()/1000) })));
  store.close();
});

test("mail confirmations are bounded when the mirror never observes the write", () => {
  assert.equal(shouldExhaustMailConfirmation(11), false);
  assert.equal(shouldExhaustMailConfirmation(12), true);
});

test("calendar confirmation checks target, alarms and exact recurrence", () => {
  const actual = {
    calendarId: "CAL-1",
    calendar: "Work",
    summary: "Demo",
    start: "2026-10-14T09:30:00.000Z",
    end: "2026-10-14T10:00:00.000Z",
    allDay: false,
    alarms: [60, 10],
    hasRecurrence: true,
    recurrence: "FREQ=WEEKLY",
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
  assert.equal(calendarFieldsMatch({ ...actual, recurrence: "FREQ=DAILY" }, expected), false);
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

test('calendar deletion needs fresh successful synchronization and baseline evidence', () => {
  const index = IndexDb.open(':memory:');
  const op = { kind: 'calendar.delete', input: {uid:'gone'}, expected:{uid:'gone',targetExisted:true}, startedAt:100, scriptFinishedAt:101 } as any;
  assert.equal(findCalendarConfirmation(index, op), null);
  index.finishSyncGeneration(1, 103000);
  assert.equal(findCalendarConfirmation(index, op), 'gone');
  assert.equal(findCalendarConfirmation(index, {...op,expected:{uid:'gone'}}), null);
  index.close();
});

test('native recurrence evidence is required and must match the requested rule', () => {
  const index=IndexDb.open(':memory:');
  const op={kind:'calendar.update',input:{uid:'u'},expected:{recurrence:'FREQ=WEEKLY'},startedAt:1} as any;
  assert.equal(findCalendarConfirmation(index,op),null);
  assert.equal(findCalendarConfirmation(index,op,{uid:'u',hasRecurrence:true,recurrence:'FREQ=DAILY'} as any),null);
  assert.equal(findCalendarConfirmation(index,op,{uid:'u',hasRecurrence:true,recurrence:'FREQ=WEEKLY'} as any),'u');
  index.close();
});

test('same-second pre-write Calendar snapshots cannot confirm deletion',()=>{
  const index=IndexDb.open(':memory:');
  const op={kind:'calendar.delete',input:{uid:'gone'},expected:{targetExisted:true},startedAt:105,scriptFinishedAt:105,scriptFinishedAtMs:105500} as any;
  index.finishSyncGeneration(1,105100);assert.equal(findCalendarConfirmation(index,op),null);
  index.finishSyncGeneration(2,105600);assert.equal(findCalendarConfirmation(index,op),'gone');index.close();
});


test('a capped mail candidate set cannot establish unique delivery', () => {
  const store=mailFixture(Array.from({length:200},(_,i)=>i===0?{}:{body:`other ${i}`}));
  assert.equal(findMailConfirmation(store,mailOperation()),null);
  store.close();
});

test('calendar confirmation follows an unambiguous historical UID alias', () => {
  const index=IndexDb.open(':memory:');
  const event={uid:'old',externalId:'stable',summary:'Renamed identity',description:null,location:null,
    start:'2026-12-01T10:00:00.000Z',end:'2026-12-01T11:00:00.000Z',allDay:false,calendarId:'c',
    calendar:'Work',account:'iCloud',alarms:[],hasRecurrence:false,status:1,url:null,lastModified:1};
  index.upsertEvent(event,'h',index.beginSyncGeneration());
  index.upsertEvent({...event,uid:'new'},'h',index.beginSyncGeneration());
  index.finishSyncGeneration(2,3000);
  assert.equal(findCalendarConfirmation(index,{kind:'calendar.update',input:{uid:'old'},expected:{summary:event.summary},startedAt:1,scriptFinishedAtMs:2000} as any),'new');
  index.close();
});
