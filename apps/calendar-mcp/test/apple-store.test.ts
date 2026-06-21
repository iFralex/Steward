import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { AppleStore } from "../src/apple-store.ts";
import { unixToCoreData } from "../src/coredata.ts";

function seed(): string {
  const path = `/tmp/cal-apple-${process.pid}-${Math.random()}.sqlitedb`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE Store(ROWID INTEGER PRIMARY KEY, name TEXT, type INTEGER);
    CREATE TABLE Calendar(ROWID INTEGER PRIMARY KEY, store_id INTEGER, title TEXT, type INTEGER);
    CREATE TABLE Location(ROWID INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE CalendarItem(ROWID INTEGER PRIMARY KEY, summary TEXT, description TEXT,
      location_id INTEGER, start_date REAL, end_date REAL, all_day INTEGER, calendar_id INTEGER,
      status INTEGER, url TEXT, last_modified REAL, has_recurrences INTEGER, entity_type INTEGER, UUID TEXT);
  `);
  db.prepare("INSERT INTO Store(ROWID,name,type) VALUES (1,'iCloud',2)").run();
  db.prepare("INSERT INTO Calendar(ROWID,store_id,title,type) VALUES (10,1,'Casa',0)").run();
  db.prepare("INSERT INTO Location(ROWID,title) VALUES (5,'Rome')").run();
  const start = unixToCoreData(Math.floor(Date.parse("2026-06-25T10:00:00Z") / 1000));
  const end = unixToCoreData(Math.floor(Date.parse("2026-06-25T11:00:00Z") / 1000));
  db.prepare(`INSERT INTO CalendarItem(ROWID,summary,description,location_id,start_date,end_date,all_day,calendar_id,status,url,last_modified,has_recurrences,entity_type,UUID)
    VALUES (100,'Dentist','checkup',5,?,?,0,10,1,'https://x','0',0,2,'UID-100')`).run(start, end);
  db.close();
  return path;
}

test("eventsInRange returns joined fields within the window", () => {
  const s = AppleStore.openReadonly(seed());
  const evs = s.eventsInRange({ startISO: "2026-06-01T00:00:00Z", endISO: "2026-07-01T00:00:00Z" });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].summary, "Dentist");
  assert.equal(evs[0].location, "Rome");
  assert.equal(evs[0].account, "iCloud");
  assert.equal(evs[0].calendar, "Casa");
  assert.equal(evs[0].start, "2026-06-25T10:00:00.000Z");
  s.close();
});

test("account filter excludes other accounts", () => {
  const s = AppleStore.openReadonly(seed());
  assert.equal(s.eventsInRange({ startISO: "2026-06-01T00:00:00Z", endISO: "2026-07-01T00:00:00Z", account: "Google" }).length, 0);
  s.close();
});

test("getEvent resolves by UID", () => {
  const s = AppleStore.openReadonly(seed());
  assert.equal(s.getEvent("UID-100")?.summary, "Dentist");
  s.close();
});
