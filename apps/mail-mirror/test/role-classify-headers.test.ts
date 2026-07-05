import assert from "node:assert/strict";
import test from "node:test";
import { makeRoleClassifier } from "../src/role-classify.ts";

test("role classifier labels itself mail-mirror/role-classify", async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return new Response(JSON.stringify({ choices: [{ message: { content: "inbox" } }] }), { status: 200 });
  }) as typeof fetch;
  const role = await makeRoleClassifier({ endpoint: "http://x", model: "tier-2" }, fetchImpl)("Posta in arrivo");
  assert.equal(role, "inbox");
  assert.equal(seen["x-usage-service"], "mail-mirror");
  assert.equal(seen["x-usage-action"], "role-classify");
});
