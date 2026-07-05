import assert from "node:assert/strict";
import test from "node:test";
import { gatewayChat } from "../src/llm.ts";

test("gatewayChat sends usage attribution headers when configured", async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  const chat = gatewayChat(
    { endpoint: "http://x/v1/chat/completions", model: "tier-5", usage: { service: "mail-promoter", action: "triage" } },
    fetchImpl,
  );
  await chat("sys", "user");
  assert.equal(seen["x-usage-service"], "mail-promoter");
  assert.equal(seen["x-usage-action"], "triage");
});
