import assert from "node:assert/strict";
import test from "node:test";
import { gatewayChat } from "../src/llm.ts";

test("action-center chat always labels itself action-center/scan", async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  await gatewayChat({ endpoint: "http://x", model: "tier-5" }, fetchImpl)("sys", "user");
  assert.equal(seen["x-usage-service"], "action-center");
  assert.equal(seen["x-usage-action"], "scan");
});

test("action-center chat can distinguish proposal revisions", async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  await gatewayChat({ endpoint: "http://x", model: "tier-5", usageAction: "revision" }, fetchImpl)("sys", "user");
  assert.equal(seen["x-usage-service"], "action-center");
  assert.equal(seen["x-usage-action"], "revision");
});
