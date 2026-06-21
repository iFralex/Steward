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

test("tiers cascade DOWN on exhaustion", () => {
  assert.match(yaml, /fallbacks:/);
  // tier-6 falls back through the lower tiers; tier-2 falls back to tier-1
  assert.match(yaml, /tier-6:\s*\[\s*"tier-5"[\s\S]*"tier-1"\s*\]/);
  assert.match(yaml, /tier-2:\s*\[\s*"tier-1"\s*\]/);
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
