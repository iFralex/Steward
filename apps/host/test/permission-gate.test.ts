import assert from "node:assert/strict";
import { test } from "node:test";
import { createPermissionGate, type ApprovalRequest } from "../src/core/permission-gate.ts";
import type { ToolPolicy } from "../src/core/tool-policy.ts";

const policy: ToolPolicy = { default: "gate", rules: { WebSearch: "allow" } };
const noopOptions = { signal: new AbortController().signal, toolUseID: "test" };

test("allow-listed tool runs without asking for approval", async () => {
  let asked = false;
  const gate = createPermissionGate(policy, async () => {
    asked = true;
    return { decision: "allow" };
  });
  const result = await gate("WebSearch", { q: "hi" }, noopOptions);
  assert.equal(result.behavior, "allow");
  assert.equal(asked, false, "must not request approval for an allowed tool");
});

test("gated tool runs only after an explicit user allow", async () => {
  const seen: ApprovalRequest[] = [];
  const gate = createPermissionGate(policy, async (req) => {
    seen.push(req);
    return { decision: "allow" };
  });
  const result = await gate("send_email", { to: "x@y.z" }, noopOptions);
  assert.equal(result.behavior, "allow");
  assert.deepEqual(seen, [{ tool: "send_email", input: { to: "x@y.z" } }]);
});

test("gated tool is denied (with the user's note) on deny", async () => {
  const gate = createPermissionGate(policy, async () => ({
    decision: "deny",
    note: "wrong recipient",
  }));
  const result = await gate("send_email", { to: "x@y.z" }, noopOptions);
  assert.equal(result.behavior, "deny");
  assert.match(result.behavior === "deny" ? result.message : "", /wrong recipient/);
});
