import assert from "node:assert/strict";
import { test } from "node:test";
import { decideTool, defaultPolicy, type ToolPolicy } from "../src/core/tool-policy.ts";

test("decideTool returns the explicit rule when present", () => {
  const policy: ToolPolicy = { default: "gate", rules: { WebSearch: "allow", Bash: "gate" } };
  assert.equal(decideTool(policy, "WebSearch"), "allow");
  assert.equal(decideTool(policy, "Bash"), "gate");
});

test("decideTool falls back to the default for unmatched tools", () => {
  const policy: ToolPolicy = { default: "gate", rules: { WebSearch: "allow" } };
  assert.equal(decideTool(policy, "SomethingUnknown"), "gate");
});

test("default policy is default-deny (gate) and allows read-only tools", () => {
  // Read-only → allowed automatically.
  assert.equal(decideTool(defaultPolicy, "WebSearch"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__llm-wiki__llm_wiki_search"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__llm-wiki__llm_wiki_read_file"), "allow");
  // Side-effecting / unknown → gated (requires confirmation).
  assert.equal(decideTool(defaultPolicy, "Bash"), "gate");
  assert.equal(decideTool(defaultPolicy, "Write"), "gate");
  assert.equal(decideTool(defaultPolicy, "mcp__llm-wiki__llm_wiki_add_source"), "gate");
  assert.equal(decideTool(defaultPolicy, "send_email"), "gate");
});
