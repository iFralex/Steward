import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRecipient } from "../src/resolve.ts";
import type { Contact } from "../src/types.ts";

function c(uid: string, first: string, emails: string[], org: string | null = null): Contact {
  return { uid, firstName: first, lastName: null, organization: org, nickname: null, note: null,
    emails: emails.map((a) => ({ address: a, label: null })), phones: [], sources: ["s1"] };
}

test("resolveRecipient returns ranked email-bearing candidates, skipping email-less", async () => {
  const byUid = new Map<string, Contact>([
    ["U1", c("U1", "Anna", ["anna@x.com"], "Studio")],
    ["U2", c("U2", "Bea", [])],                 // no email -> skipped
    ["U3", c("U3", "Carlo", ["carlo@y.com", "c2@y.com"])],
  ]);
  const out = await resolveRecipient(
    { search: async () => ["U1", "U2", "U3"], getContact: (u) => byUid.get(u) },
    "studio",
    5,
  );
  assert.deepEqual(out.map((r) => r.email), ["anna@x.com", "carlo@y.com", "c2@y.com"]);
  assert.equal(out[0].displayName, "Anna");
  assert.equal(out[0].organization, "Studio");
  assert.ok(out[0].score >= out[2].score); // earlier hits rank higher
});

test("resolveRecipient respects the limit", async () => {
  const byUid = new Map<string, Contact>([
    ["U1", c("U1", "Anna", ["a@x.com", "a2@x.com"])],
  ]);
  const out = await resolveRecipient({ search: async () => ["U1"], getContact: (u) => byUid.get(u) }, "anna", 1);
  assert.equal(out.length, 1);
});
