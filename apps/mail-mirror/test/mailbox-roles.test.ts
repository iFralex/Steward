// apps/mail-mirror/test/mailbox-roles.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { roleFromAttributes, discoverRoles } from "../src/mailbox-roles.ts";

test("roleFromAttributes decodes real SPECIAL-USE bits (base 0x40 masked)", () => {
  assert.equal(roleFromAttributes(64 + 0x1000, "Bozze"), "drafts");
  assert.equal(roleFromAttributes(64 + 0x8000, "Posta inviata"), "sent");
  assert.equal(roleFromAttributes(64 + 0x10000, "Cestino"), "trash");
  assert.equal(roleFromAttributes(64 + 0x4000, "Spam"), "junk");
  assert.equal(roleFromAttributes(64 + 0x400, "Tutti i messaggi"), "archive");
  assert.equal(roleFromAttributes(64 + 0x20000, "Importanti"), "important");
  assert.equal(roleFromAttributes(64, "INBOX"), "inbox");
  assert.equal(roleFromAttributes(0, "RandomFolder"), null);
});

test("discoverRoles: SPECIAL-USE first, AI fallback for an attribute-less name, then localized terms", async () => {
  const s = Store.open(":memory:");
  const readMboxCache = async () => [
    { name: "Posta inviata", attr: 64 + 0x8000 }, // SPECIAL-USE → sent
    { name: "Quarantena", attr: 0 },              // no bit → AI
    { name: "Bozze", attr: 0 },                   // no bit, AI says none → localized term
  ];
  const classifyRole = async (n: string) => (n === "Quarantena" ? "junk" : null);
  const localizedTerms = async () => ({
    inbox: [], drafts: ["bozze"], sent: [], trash: [], junk: [], archive: [], important: [], flagged: [],
  });
  await discoverRoles({ store: s, mailRoot: "/x", accountUuids: ["U1"], readMboxCache, classifyRole, localizedTerms });
  assert.equal(s.roleForMailbox("U1", "Posta inviata"), "sent");
  assert.equal(s.roleForMailbox("U1", "Quarantena"), "junk");
  assert.equal(s.roleForMailbox("U1", "Bozze"), "drafts");
  assert.deepEqual(s.mailboxesForRole("U1", "sent"), ["Posta inviata"]);
  s.close();
});
