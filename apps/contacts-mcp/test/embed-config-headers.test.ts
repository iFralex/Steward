import assert from "node:assert/strict";
import test from "node:test";
import { loadEmbedConfig } from "../src/embed-config.ts";

test("embed config carries contacts-mcp/embed attribution", () => {
  const cfg = loadEmbedConfig({});
  assert.ok(cfg);
  assert.equal(cfg.extraHeaders?.["x-usage-service"], "contacts-mcp");
  assert.equal(cfg.extraHeaders?.["x-usage-action"], "embed");
});
