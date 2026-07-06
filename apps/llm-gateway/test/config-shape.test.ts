// apps/llm-gateway/test/config-shape.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptsFor, fallbackOrder, models, rates } from "../src/gateway.ts";

test("compat gateway declares the capability ladder tier-1..tier-6 + local-embed", () => {
  for (const name of ["tier-1", "tier-2", "tier-3", "tier-4", "tier-5", "tier-6", "local-embed"]) {
    assert.ok(models[name], `missing model: ${name}`);
  }
});

test("chat tiers map to DeepSeek and local/embed tiers map to Ollama", () => {
  assert.equal(models["tier-1"].provider, "ollama");
  assert.equal(models["tier-1"].model, "llama3.2:1b");
  assert.equal(models["local-embed"].provider, "ollama");
  assert.equal(models["local-embed"].model, "bge-m3");
  assert.equal(models["tier-2"].provider, "deepseek");
  assert.equal(models["tier-5"].model, "deepseek-v4-flash");
  assert.equal(models["tier-6"].model, "deepseek-v4-pro");
});

test("paid tiers fall back across the paid DeepSeek ladder only", () => {
  assert.deepEqual(fallbackOrder["tier-5"], ["tier-5", "tier-6", "tier-4", "tier-3", "tier-2"]);
  assert.deepEqual(attemptsFor("tier-5").map((a) => a.target.model), [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash",
    "deepseek-v4-flash",
  ]);
  assert.equal(fallbackOrder["tier-5"].includes("tier-1"), false);
});

test("DeepSeek API keys are read from env at module load time", async () => {
  assert.equal(models["tier-2"].apiKey, process.env.DEEPSEEK_API_KEY);
});

test("local-embed rates are zero so embed tokens are never priced at a paid fallback", () => {
  assert.ok(rates["local-embed"], "missing rates entry for local-embed");
  assert.deepEqual(rates["local-embed"], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
