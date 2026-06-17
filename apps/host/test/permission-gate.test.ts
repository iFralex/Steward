import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { createPreToolUseGate, type ApprovalRequest } from "../src/core/permission-gate.ts";
import type { ToolPolicy } from "../src/core/tool-policy.ts";

const policy: ToolPolicy = { default: "gate", rules: { WebSearch: "allow" } };
const hookOpts = { signal: new AbortController().signal };

function input(toolName: string, toolInput: unknown): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "t1",
  } as unknown as PreToolUseHookInput;
}

interface HookOut {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

test("allow-listed tool is allowed without asking", async () => {
  let asked = false;
  const gate = createPreToolUseGate(policy, async () => {
    asked = true;
    return { decision: "allow" };
  });
  const out = (await gate(input("WebSearch", { q: "hi" }), "t1", hookOpts)) as HookOut;
  assert.equal(out.hookSpecificOutput?.permissionDecision, "allow");
  assert.equal(asked, false);
});

test("gated tool asks, and is allowed on user allow", async () => {
  const seen: ApprovalRequest[] = [];
  const gate = createPreToolUseGate(policy, async (req) => {
    seen.push(req);
    return { decision: "allow" };
  });
  const out = (await gate(input("Bash", { command: "ls" }), "t1", hookOpts)) as HookOut;
  assert.equal(out.hookSpecificOutput?.permissionDecision, "allow");
  assert.deepEqual(seen, [{ tool: "Bash", input: { command: "ls" } }]);
});

test("user note on allow reaches the model as additional context", async () => {
  const gate = createPreToolUseGate(policy, async () => ({ decision: "allow", note: "use prod" }));
  const out = (await gate(input("Bash", {}), "t1", hookOpts)) as HookOut;
  assert.equal(out.hookSpecificOutput?.permissionDecision, "allow");
  assert.match(out.hookSpecificOutput?.additionalContext ?? "", /use prod/);
});

test("gated tool is denied (with note) on user deny", async () => {
  const gate = createPreToolUseGate(policy, async () => ({ decision: "deny", note: "wrong recipient" }));
  const out = (await gate(input("send_email", {}), "t1", hookOpts)) as HookOut;
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? "", /wrong recipient/);
});
