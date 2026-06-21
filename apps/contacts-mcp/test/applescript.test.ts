import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreate, mapContactsError, createContact } from "../src/applescript.ts";

test("buildCreate sets name fields and escapes quotes", () => {
  const s = buildCreate({ firstName: 'a"b', lastName: "Rossi", organization: "ACME" });
  assert.match(s, /make new person/);
  assert.match(s, /first name:"a\\"b"/);
  assert.match(s, /organization:"ACME"/);
});

test("buildCreate adds emails as child objects", () => {
  const s = buildCreate({ firstName: "Anna", emails: [{ address: "anna@x.com", label: "Home" }] });
  assert.match(s, /make new email at end of emails of/);
  assert.match(s, /value:"anna@x.com"/);
});

test("mapContactsError explains automation denial", () => {
  assert.match(mapContactsError("-1743 Not authorized"), /Automation/);
});

test("createContact returns the id printed by the script", async () => {
  const id = await createContact({ firstName: "Anna" }, async () => "ABC-123\n");
  assert.equal(id, "ABC-123");
});
