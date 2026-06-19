// apps/mail-mcp/test/scope.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../mail-mirror/src/store.ts";
import { resolveScope } from "../src/scope.ts";

test("resolveScope maps account email to UUID and role keyword to mailbox names", () => {
  const s = Store.open(":memory:");
  s.upsertAccount("U1", "Business", ["biz@x.com"]);
  s.upsertMailboxRole("U1", "Bozze", "drafts");
  s.upsertMailboxRole("U1", "Posta inviata", "sent");
  const r = resolveScope(s, { account: "biz@x.com", mailbox: "drafts" });
  assert.equal(r.account, "U1");
  assert.deepEqual(r.mailboxNames, ["Bozze"]);
  s.close();
});

test("resolveScope passes through an unknown account and a literal mailbox name", () => {
  const s = Store.open(":memory:");
  const r = resolveScope(s, { account: "RAW-UUID", mailbox: "Custom Folder" });
  assert.equal(r.account, "RAW-UUID");
  assert.deepEqual(r.mailboxNames, ["Custom Folder"]);
  s.close();
});

test("resolveScope role across all accounts when no account given", () => {
  const s = Store.open(":memory:");
  s.upsertMailboxRole("U1", "Cestino", "trash");
  s.upsertMailboxRole("U2", "Trash", "trash");
  const r = resolveScope(s, { mailbox: "trash" });
  assert.deepEqual(new Set(r.mailboxNames), new Set(["Cestino", "Trash"]));
  s.close();
});
