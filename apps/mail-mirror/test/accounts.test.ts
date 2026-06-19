// apps/mail-mirror/test/accounts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { parseAccounts, refreshAccounts } from "../src/accounts.ts";

test("parseAccounts splits id|name|emails lines", () => {
  const out = "UUID1\tGoogle\ta@x.com,b@x.com\nUUID2\tWork\tc@y.com\n";
  assert.deepEqual(parseAccounts(out), [
    { uuid: "UUID1", name: "Google", emails: ["a@x.com", "b@x.com"] },
    { uuid: "UUID2", name: "Work", emails: ["c@y.com"] },
  ]);
});

test("refreshAccounts upserts and account lookup resolves by email or name", async () => {
  const s = Store.open(":memory:");
  const stub = async () => "UUID1\tGoogle\ta@x.com,b@x.com\n";
  const n = await refreshAccounts(s, stub);
  assert.equal(n, 1);
  assert.equal(s.accountByEmailOrName("b@x.com"), "UUID1");
  assert.equal(s.accountByEmailOrName("google"), "UUID1");
  assert.equal(s.accountByEmailOrName("nope"), undefined);
  assert.ok(s.hasAccount("UUID1"));
  s.close();
});

test("refreshAccounts returns 0 when AppleScript fails", async () => {
  const s = Store.open(":memory:");
  const n = await refreshAccounts(s, async () => { throw new Error("no Mail"); });
  assert.equal(n, 0);
  s.close();
});
