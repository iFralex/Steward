import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { makeEmbedDeps } from "../src/cli.ts";

test("makeEmbedDeps returns null when no endpoint configured", () => {
  const s = Store.open(":memory:");
  const saved = process.env.MAIL_EMBED_ENDPOINT;
  delete process.env.MAIL_EMBED_ENDPOINT;
  assert.equal(makeEmbedDeps(s), null);
  if (saved) process.env.MAIL_EMBED_ENDPOINT = saved;
  s.close();
});

test("makeEmbedDeps wires deps when an endpoint is set", () => {
  const s = Store.open(":memory:");
  process.env.MAIL_EMBED_ENDPOINT = "http://127.0.0.1:1234/v1/embeddings";
  process.env.MAIL_EMBED_MODEL = "m";
  const d = makeEmbedDeps(s);
  assert.ok(d && typeof d.embed === "function" && d.model === "m");
  delete process.env.MAIL_EMBED_ENDPOINT;
  delete process.env.MAIL_EMBED_MODEL;
  s.close();
});
