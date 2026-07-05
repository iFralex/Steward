import assert from "node:assert/strict";
import test from "node:test";
import { loadEmbedConfig } from "../src/embed-config.ts";

test("embed config carries calendar-mcp/embed attribution", () => {
  const cfg = loadEmbedConfig({});
  assert.ok(cfg);
  assert.equal(cfg.extraHeaders?.["x-usage-service"], "calendar-mcp");
  assert.equal(cfg.extraHeaders?.["x-usage-action"], "embed");
});
