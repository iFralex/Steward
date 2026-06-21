// apps/llm-gateway/test/config-shape.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const yaml = readFileSync(new URL("../litellm.config.yaml", import.meta.url), "utf8");

test("config declares the capability ladder tier-1..tier-6 + local-embed", () => {
  for (const name of ["tier-1", "tier-2", "tier-3", "tier-4", "tier-5", "tier-6", "local-embed"]) {
    assert.ok(new RegExp(`model_name:\\s*${name}\\b`).test(yaml), `missing model_name: ${name}`);
  }
});

test("each free tier lists several comparable models (intra-tier failover)", () => {
  // tier-1/2/3 each have multiple deployments = comparable models to fail over across
  for (const tier of ["tier-1", "tier-2", "tier-3"]) {
    const n = (yaml.match(new RegExp(`model_name:\\s*${tier}\\b`, "g")) ?? []).length;
    assert.ok(n >= 2, `expected >=2 comparable models in ${tier}, got ${n}`);
  }
});

test("on failure a tier escalates UP then sweeps the rest, covering every tier", () => {
  assert.match(yaml, /fallbacks:/);
  // tier-3 climbs to 4,5,6 then sweeps down to 2,1 (all five other tiers tried)
  assert.match(yaml, /tier-3:\s*\["tier-4", "tier-5", "tier-6", "tier-2", "tier-1"\]/);
  // even the top tier-6 falls back down through every lower tier
  assert.match(yaml, /tier-6:\s*\["tier-5", "tier-4", "tier-3", "tier-2", "tier-1"\]/);
  // a request never starts by escalating into a weaker tier: tier-1 only goes up
  assert.match(yaml, /tier-1:\s*\["tier-2", "tier-3", "tier-4", "tier-5", "tier-6"\]/);
});

test("api keys and retries come from config, not hardcoded secrets", () => {
  assert.match(yaml, /os\.environ\/OPENROUTER_API_KEY_1/);
  assert.match(yaml, /num_retries:/);
  assert.match(yaml, /cooldown_time:/);
});

test("the top tiers route to the subscription adapter", () => {
  // tier-4/5/6 are Claude-on-subscription via the :4001 adapter
  assert.match(yaml, /model_name:\s*tier-6\b[\s\S]*?model:\s*openai\/claude-opus-sub/);
  assert.match(yaml, /api_base:\s*http:\/\/127\.0\.0\.1:4001\/v1/);
});
