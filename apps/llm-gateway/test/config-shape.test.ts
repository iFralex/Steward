// apps/llm-gateway/test/config-shape.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const yaml = readFileSync(new URL("../litellm.config.yaml", import.meta.url), "utf8");

test("config declares the required model-group names", () => {
  for (const name of ["local-chat", "local-embed", "api-default", "api-alt1", "api-alt2"]) {
    assert.ok(new RegExp(`model_name:\\s*${name}\\b`).test(yaml), `missing model_name: ${name}`);
  }
});

test("api tier rotates keys and falls back across models", () => {
  // at least two api-default deployments (key-pool rotation)
  const apiDefaults = (yaml.match(/model_name:\s*api-default\b/g) ?? []).length;
  assert.ok(apiDefaults >= 2, "expected >=2 api-default deployments for key rotation");
  // a fallbacks mapping from api-default to the alt models
  assert.match(yaml, /fallbacks:/);
  assert.match(yaml, /api-default[\s\S]*api-alt1/);
  assert.match(yaml, /api-default[\s\S]*api-alt2/);
});

test("api keys and retries come from config, not hardcoded secrets", () => {
  assert.match(yaml, /os\.environ\/OPENROUTER_API_KEY_1/);
  assert.match(yaml, /num_retries:/);
  assert.match(yaml, /cooldown_time:/);
});

test("config registers the sub-* adapter tier", () => {
  assert.match(yaml, /model_name:\s*sub-opus\b/);
  assert.match(yaml, /api_base:\s*http:\/\/127\.0\.0\.1:4001\/v1/);
});
