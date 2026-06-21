import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb, displayNameOf } from "../src/index-db.ts";
import type { Contact } from "../src/types.ts";

function c(uid: string, first: string, org: string | null = null): Contact {
  return { uid, firstName: first, lastName: null, organization: org, nickname: null, note: null,
    emails: [{ address: `${first.toLowerCase()}@x.com`, label: null }], phones: [], sources: ["s1"] };
}

test("displayNameOf falls back name -> org -> email", () => {
  assert.equal(displayNameOf(c("U1", "Anna")), "Anna");
  assert.equal(displayNameOf({ ...c("U2", "", null), firstName: null, organization: "ACME" }), "ACME");
});

test("upsert + FTS finds by name token", () => {
  const db = IndexDb.open(":memory:");
  db.upsertContact(c("U1", "Cristian", "Studio Rossi"), "h1");
  db.upsertContact(c("U2", "Marco"), "h2");
  assert.deepEqual(db.ftsSearch('"cristian"', 10), ["U1"]);
  assert.deepEqual(db.ftsSearch('"studio"', 10), ["U1"]);
  db.close();
});

test("deleteMissing removes uids not kept; embed bookkeeping round-trips", () => {
  const db = IndexDb.open(":memory:");
  db.upsertContact(c("U1", "Anna"), "h1");
  db.upsertContact(c("U2", "Bea"), "h2");
  assert.equal(db.deleteMissing(["U1"]), 1);
  assert.deepEqual(db.allUids(), ["U1"]);
  assert.equal(db.embedStateFor("U1"), undefined);
  db.recordEmbed("U1", "h1", 3, "local-embed");
  assert.equal(db.embedStateFor("U1")?.sourceHash, "h1");
  db.close();
});
