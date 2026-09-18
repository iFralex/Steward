import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerGatewayModel } from "../src/core/pi-provider.ts";

test("gateway provider registration carries usage attribution headers", async () => {
  const { modelRegistry } = registerGatewayModel({
    baseUrl: "http://127.0.0.1:4000/v1", tier: "tier-5", apiKey: "x",
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  });
  const model = modelRegistry.find("gateway", "tier-5");
  assert.ok(model);
  // `getApiKeyAndHeaders` is the real ModelRegistry method for resolving a
  // model's API key + request headers (see model-registry.d.ts ~line 70:
  // "Get API key and request headers for a model."). The brief's sketch used
  // a placeholder name (`getAuthForModel`) that doesn't exist on the class.
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  assert.ok(auth.ok, auth.ok ? undefined : auth.error);
  assert.equal(auth.ok && auth.headers?.["x-usage-service"], "host");
  assert.equal(auth.ok && auth.headers?.["x-usage-action"], "agent-turn");
});

test("gateway provider accepts a dedicated usage action for automatic work", async () => {
  const { modelRegistry } = registerGatewayModel({
    baseUrl: "http://127.0.0.1:4000/v1", tier: "tier-5", apiKey: "x",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    usageService: "host", usageAction: "watch-notification",
  });
  const model = modelRegistry.find("gateway", "tier-5");
  assert.ok(model);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  assert.ok(auth.ok, auth.ok ? undefined : auth.error);
  assert.equal(auth.ok && auth.headers?.["x-usage-service"], "host");
  assert.equal(auth.ok && auth.headers?.["x-usage-action"], "watch-notification");
});

test("agent-runner no longer writes the legacy turns ledger", () => {
  const src = readFileSync(new URL("../src/core/agent-runner.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("usageStore"), "agent-runner still references the removed usage-store");
  assert.ok(!src.includes(".record({"), "agent-runner still records turn rows");
});
