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
  assert.equal(decideTool(defaultPolicy, "mcp__llm-wiki__llm_wiki_search"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__mail__read_message"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__llm-wiki__llm_wiki_read_file"), "allow");
  // Side-effecting / unknown → gated (requires confirmation).
  assert.equal(decideTool(defaultPolicy, "Bash"), "gate");
  assert.equal(decideTool(defaultPolicy, "Write"), "gate");
  assert.equal(decideTool(defaultPolicy, "mcp__llm-wiki__llm_wiki_add_source"), "gate");
  assert.equal(decideTool(defaultPolicy, "send_email"), "gate");
});

test("account connectors (Gmail/Google) are hard-denied via deny-prefixes", () => {
  assert.equal(decideTool(defaultPolicy, "mcp__claude_ai_Gmail__authenticate"), "deny");
  assert.equal(decideTool(defaultPolicy, "mcp__claude_ai_Google_Calendar__authenticate"), "deny");
  assert.equal(decideTool(defaultPolicy, "mcp__claude_ai_Google_Drive__search_files"), "deny");
});

test("deny-prefixes do not affect our own mail/wiki tools", () => {
  assert.equal(decideTool(defaultPolicy, "mcp__mail__search_messages"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__llm-wiki__llm_wiki_search"), "allow");
});

test("mail read tools are allowed; mail send tools are gated", () => {
  assert.equal(decideTool(defaultPolicy, "mcp__mail__search_messages"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__mail__read_message"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__mail__list_mailboxes"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__mail__save_attachment"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__mail__send_email"), "gate");
  assert.equal(decideTool(defaultPolicy, "mcp__mail__reply"), "gate");
});

test("train reads and generic watch lifecycle are automatic", () => {
  assert.equal(decideTool(defaultPolicy, "mcp__trains__find_next_train"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__trains__train_status"), "allow");
  assert.equal(decideTool(defaultPolicy, "create_watch"), "allow");
  assert.equal(decideTool(defaultPolicy, "create_agent_watch"), "gate");
  assert.equal(decideTool(defaultPolicy, "stop_watch"), "allow");
});

test("voice continuation is automatic but dialing remains gated", () => {
  assert.equal(decideTool(defaultPolicy, "mcp__voice__call_start"), "gate");
  assert.equal(decideTool(defaultPolicy, "mcp__voice__converse"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__voice__listen"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__voice__speak"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__voice__call_end"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__voice__call_status"), "allow");
  assert.equal(decideTool(defaultPolicy, "mcp__voice__get_conversation"), "allow");
});
