import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayBackoff } from "../src/gateway-backoff.ts";
import { GatewayChatError, gatewayChat } from "../src/llm.ts";

test("gateway failures persist across instances, back off, and recover", async () => {
  const data = new Map<string, unknown>();
  const store = { getMeta: <T>(key: string) => (data.get(key) as T) ?? null, setMeta: (key: string, value: unknown) => { data.set(key, value); } };
  let now = 1_000, calls = 0;
  const clock = () => now;
  const first = new GatewayBackoff(store, clock);
  const fail = first.wrap(async () => { calls++; throw new GatewayChatError(402); });
  await assert.rejects(fail("", ""), /402/);
  assert.equal(first.state?.until, now + 15 * 60_000);
  const next = new GatewayBackoff(store, clock);
  await assert.rejects(next.wrap(async () => { calls++; return "ok"; })("", ""), /gateway-backoff/);
  assert.equal(calls, 1);
  now = first.state!.until;
  await assert.rejects(next.wrap(async () => { calls++; throw new GatewayChatError(502); })("", ""), /502/);
  assert.equal(next.state?.until, now + 30 * 60_000);
  now = next.state!.until;
  assert.equal(await next.wrap(async () => "ok")("", ""), "ok");
  assert.equal(next.active, false);
  assert.equal(next.state?.failures, 0);
});

test("gateway classifies network and HTTP failures, without backing off on 400", async () => {
  const data = new Map<string, unknown>();
  const store = { getMeta: <T>(key: string) => (data.get(key) as T) ?? null, setMeta: (key: string, value: unknown) => { data.set(key, value); } };
  const backoff = new GatewayBackoff(store, () => 100);
  const http = gatewayChat({ endpoint: "http://localhost" }, async () => new Response("", { status: 400 }));
  await assert.rejects(backoff.wrap(http)("", ""), /400/);
  assert.equal(backoff.active, false);
  const network = gatewayChat({ endpoint: "http://localhost" }, async () => { throw new Error("offline"); });
  await assert.rejects(backoff.wrap(network)("", ""), /chat 0/);
  assert.equal(backoff.state?.status, 0);
  assert.equal(backoff.active, true);
});
