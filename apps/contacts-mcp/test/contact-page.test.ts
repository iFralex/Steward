import assert from "node:assert/strict";
import test from "node:test";
import { buildContactSearchPage } from "../src/contact-page.ts";
import type { Contact } from "../src/types.ts";

const contact = (index: number): Contact => ({
  uid: `contact-${index}`,
  firstName: `First ${index}`,
  lastName: "Person",
  organization: "Organization",
  nickname: null,
  note: `${index}: ${"x".repeat(500)}`,
  emails: [{ address: `person${index}@example.com`, label: "work" }],
  phones: [{ number: `+390000${index}`, label: "mobile" }],
  sources: ["internal-address-book-uuid"],
});

test("returns a contact page with a continuation offset", () => {
  const page = buildContactSearchPage(Array.from({ length: 9 }, (_, i) => contact(i)), 8, 16);
  assert.equal(page.contacts.length, 8);
  assert.deepEqual(page.page, { offset: 16, returned: 8, hasMore: true, nextOffset: 24 });
});

test("keeps identifiers and every address while omitting internal sources", () => {
  const page = buildContactSearchPage(Array.from({ length: 5 }, (_, i) => contact(i)), 8, 0);
  const first = page.contacts[0] as unknown as Record<string, unknown>;
  assert.equal(first.uid, "contact-0");
  assert.deepEqual(first.emails, [{ address: "person0@example.com", label: "work" }]);
  assert.deepEqual(first.phones, [{ number: "+3900000", label: "mobile" }]);
  assert.equal("sources" in first, false);
  assert.ok((page.contacts[0].note?.length ?? 0) <= 200);
  assert.ok((page.contacts[3].note?.length ?? 0) <= 100);
  assert.deepEqual(page.page, { offset: 0, returned: 5, hasMore: false });
});
