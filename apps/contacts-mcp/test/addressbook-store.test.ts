import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { AddressBookStore } from "../src/addressbook-store.ts";

function seedSource(tag: string, rows: { pk: number; uid: string; first?: string; last?: string; org?: string; emails?: string[] }[]): string {
  const path = `/tmp/abk-${tag}-${process.pid}-${Math.random()}.abcddb`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD(Z_PK INTEGER PRIMARY KEY, ZUNIQUEID TEXT, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT, ZNOTE TEXT);
    CREATE TABLE ZABCDEMAILADDRESS(Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT, ZADDRESSNORMALIZED TEXT, ZLABEL TEXT);
    CREATE TABLE ZABCDPHONENUMBER(Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT, ZLABEL TEXT);
  `);
  let eid = 1;
  for (const r of rows) {
    db.prepare("INSERT INTO ZABCDRECORD(Z_PK,ZUNIQUEID,ZFIRSTNAME,ZLASTNAME,ZORGANIZATION) VALUES (?,?,?,?,?)")
      .run(r.pk, r.uid, r.first ?? null, r.last ?? null, r.org ?? null);
    for (const e of r.emails ?? []) {
      db.prepare("INSERT INTO ZABCDEMAILADDRESS(Z_PK,ZOWNER,ZADDRESS,ZADDRESSNORMALIZED,ZLABEL) VALUES (?,?,?,?,?)")
        .run(eid++, r.pk, e, e.toLowerCase(), "_$!<Home>!$_");
    }
  }
  db.close();
  return path;
}

test("aggregates people across sources and joins emails", () => {
  const s1 = seedSource("a", [{ pk: 1, uid: "U1", first: "Anna", last: "Bianchi", emails: ["anna@x.com"] }]);
  const s2 = seedSource("b", [{ pk: 1, uid: "U2", org: "Studio", emails: ["info@studio.it"] }]);
  const store = AddressBookStore.load([s1, s2]);
  const all = store.listContacts();
  assert.equal(all.length, 2);
  const anna = all.find((c) => c.firstName === "Anna")!;
  assert.equal(anna.emails[0].address, "anna@x.com");
  assert.equal(anna.emails[0].label, "Home");
});

test("dedupes the same person (same email) appearing in two sources, merging", () => {
  const s1 = seedSource("c", [{ pk: 1, uid: "U1", first: "Carla", emails: ["carla@x.com"] }]);
  const s2 = seedSource("d", [{ pk: 9, uid: "U9", first: "Carla", org: "ACME", emails: ["carla@x.com"] }]);
  const store = AddressBookStore.load([s1, s2]);
  const all = store.listContacts();
  assert.equal(all.length, 1);
  assert.equal(all[0].organization, "ACME"); // merged in from the second source
  assert.equal(all[0].sources.length, 2);
});

test("coerces non-string column values (real stores put numbers in text cols)", () => {
  const path = `/tmp/abk-num-${process.pid}-${Math.random()}.abcddb`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD(Z_PK INTEGER PRIMARY KEY, ZUNIQUEID TEXT, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT, ZNOTE TEXT);
    CREATE TABLE ZABCDEMAILADDRESS(Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT, ZADDRESSNORMALIZED TEXT, ZLABEL TEXT);
    CREATE TABLE ZABCDPHONENUMBER(Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT, ZLABEL TEXT);
  `);
  db.prepare("INSERT INTO ZABCDRECORD(Z_PK,ZUNIQUEID,ZFIRSTNAME,ZORGANIZATION) VALUES (1,'U1','Eve',2024)").run();
  db.prepare("INSERT INTO ZABCDRECORD(Z_PK,ZUNIQUEID,ZFIRSTNAME,ZORGANIZATION) VALUES (2,'U2','Eve',2025)").run();
  db.prepare("INSERT INTO ZABCDEMAILADDRESS(Z_PK,ZOWNER,ZADDRESS,ZADDRESSNORMALIZED) VALUES (1,1,'eve@x.com','eve@x.com')").run();
  db.prepare("INSERT INTO ZABCDEMAILADDRESS(Z_PK,ZOWNER,ZADDRESS,ZADDRESSNORMALIZED) VALUES (2,2,'eve@x.com','eve@x.com')").run();
  db.close();
  // same email -> merge path runs firstNonEmpty over the numeric organization without throwing
  const store = AddressBookStore.load([path]);
  const all = store.listContacts();
  assert.equal(all.length, 1);
  assert.equal(typeof all[0].organization, "string");
  assert.equal(all[0].organization, "2024");
});

test("getContact resolves by uid", () => {
  const s1 = seedSource("e", [{ pk: 1, uid: "U1", first: "Dino", emails: ["dino@x.com"] }]);
  const store = AddressBookStore.load([s1]);
  const uid = store.listContacts()[0].uid;
  assert.equal(store.getContact(uid)?.firstName, "Dino");
});
