import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IndexDb } from "../../contacts-mcp/src/index-db.ts";
import { lookupContactContext } from "../src/context.ts";
import type { Contact } from "../../contacts-mcp/src/types.ts";

function contact(uid: string, firstName: string, lastName: string | null, email: string): Contact {
  return {
    uid,
    firstName,
    lastName,
    organization: null,
    nickname: null,
    note: null,
    emails: [{ address: email, label: null }],
    phones: [],
    sources: ["test"],
  };
}

test("lookupContactContext does not match arbitrary first-name-only contacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "action-center-contacts-"));
  const dbPath = join(dir, "contacts.db");
  const old = process.env.CONTACTS_INDEX_DB;
  process.env.CONTACTS_INDEX_DB = dbPath;
  const db = IndexDb.open(dbPath);
  db.upsertContact(contact("u1", "Giulia", "Sorella", "giulia.personal@example.net"), "h1");
  db.upsertContact(contact("u2", "Giulia", "Università", "giulia.uni@example.net"), "h2");
  db.close();

  try {
    const ctx = lookupContactContext({ fromName: "Giulia Crespi", fromAddr: "giulia.crespi@steantycip.com" });
    assert.deepEqual(ctx.matches, []);
  } finally {
    if (old == null) delete process.env.CONTACTS_INDEX_DB;
    else process.env.CONTACTS_INDEX_DB = old;
  }
});

