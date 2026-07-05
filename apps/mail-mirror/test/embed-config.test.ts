import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEmbedConfig } from "../src/embed-config.ts";

test("defaults to the LLM gateway when MAIL_EMBED_ENDPOINT is unset", () => {
  const cfg = loadEmbedConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg?.endpoint, "http://127.0.0.1:4000/v1/embeddings");
  assert.equal(cfg?.model, "local-embed");
});

test("returns null when explicitly disabled (off / empty)", () => {
  assert.equal(loadEmbedConfig({ MAIL_EMBED_ENDPOINT: "off" } as unknown as NodeJS.ProcessEnv), null);
  assert.equal(loadEmbedConfig({ MAIL_EMBED_ENDPOINT: "" } as unknown as NodeJS.ProcessEnv), null);
});

test("reads endpoint/model/key/dim from env", () => {
  const cfg = loadEmbedConfig({ MAIL_EMBED_ENDPOINT: "http://127.0.0.1:1234/v1/embeddings", MAIL_EMBED_MODEL: "m", MAIL_EMBED_API_KEY: "k", MAIL_EMBED_DIM: "768" } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg?.endpoint, "http://127.0.0.1:1234/v1/embeddings");
  assert.equal(cfg?.model, "m");
  assert.equal(cfg?.apiKey, "k");
  assert.equal(cfg?.outputDimensionality, 768);
});

test("loadEmbedConfig attaches usage attribution extraHeaders with the caller's service", () => {
  const cfg = loadEmbedConfig({}, "mail-mcp");
  assert.ok(cfg);
  assert.equal(cfg.extraHeaders?.["x-usage-service"], "mail-mcp");
  assert.equal(cfg.extraHeaders?.["x-usage-action"], "embed");
  const def = loadEmbedConfig({});
  assert.equal(def?.extraHeaders?.["x-usage-service"], "mail-mirror");
});
