import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEmbedConfig } from "../src/embed-config.ts";

test("returns null when no endpoint", () => {
  assert.equal(loadEmbedConfig({} as NodeJS.ProcessEnv), null);
});

test("reads endpoint/model/key/dim from env", () => {
  const cfg = loadEmbedConfig({ MAIL_EMBED_ENDPOINT: "http://127.0.0.1:1234/v1/embeddings", MAIL_EMBED_MODEL: "m", MAIL_EMBED_API_KEY: "k", MAIL_EMBED_DIM: "768" } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg?.endpoint, "http://127.0.0.1:1234/v1/embeddings");
  assert.equal(cfg?.model, "m");
  assert.equal(cfg?.apiKey, "k");
  assert.equal(cfg?.outputDimensionality, 768);
});
