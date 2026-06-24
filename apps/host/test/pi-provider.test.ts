import { test } from "node:test";
import assert from "node:assert/strict";
import { registerGatewayModel } from "../src/core/pi-provider.ts";

test("registers the gateway provider and resolves the tier model", () => {
  const { model } = registerGatewayModel({
    baseUrl: "http://127.0.0.1:4000/v1",
    tier: "tier-5",
    apiKey: "sk-local",
    cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
  });
  assert.equal(model.id, "tier-5");
  assert.equal(model.provider, "gateway");
});
