// apps/mail-mirror/test/role-classify.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRoleClassifier } from "../src/role-classify.ts";

test("classifier maps a valid reply to a role and 'none' to null", async () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "junk" } }] }) }) as any;
  const c = makeRoleClassifier({ endpoint: "http://x/v1/chat/completions", model: "m" }, fetchStub);
  assert.equal(await c("Quarantena"), "junk");

  const noneStub = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "none" } }] }) }) as any;
  const c2 = makeRoleClassifier({ endpoint: "http://x/v1/chat/completions", model: "m" }, noneStub);
  assert.equal(await c2("Weird Folder"), null);
});

test("classifier returns null on a fetch error", async () => {
  const c = makeRoleClassifier({ endpoint: "http://x", model: "m" }, async () => { throw new Error("down"); });
  assert.equal(await c("x"), null);
});

test("classifier returns null on a non-ok HTTP response", async () => {
  const fetchStub = async () => ({ ok: false, json: async () => ({}) }) as any;
  const c = makeRoleClassifier({ endpoint: "http://x/v1/chat/completions", model: "m" }, fetchStub);
  assert.equal(await c("AnyFolder"), null);
});
