import { test } from "node:test";
import assert from "node:assert/strict";
import { gateToolDefinition, type RequestApproval } from "../src/core/permission-gate.ts";
import type { ToolPolicy } from "../src/core/tool-policy.ts";

const policy: ToolPolicy = { default: "gate", rules: { read: "allow", banned: "deny" } };

function fakeTool(name: string, calls: any[]) {
  return {
    name, label: name, description: name,
    parameters: { type: "object", properties: {} } as any,
    execute: async (_id: string, params: any) => { calls.push(params); return { content: [{ type: "text", text: "RAN" }], details: {} }; },
  } as any;
}
const noFollowUp = () => ({ followUp: async () => {} });
const denyAll: RequestApproval = async () => ({ decision: "deny", note: "nope" });

test("allow tool runs without approval", async () => {
  const calls: any[] = [];
  const t = gateToolDefinition(fakeTool("read", calls), policy, denyAll, noFollowUp);
  const res: any = await t.execute("1", { a: 1 });
  assert.equal(res.content[0].text, "RAN");
  assert.deepEqual(calls, [{ a: 1 }]);
});

test("deny tool never runs", async () => {
  const calls: any[] = [];
  const t = gateToolDefinition(fakeTool("banned", calls), policy, denyAll, noFollowUp);
  const res: any = await t.execute("1", {});
  assert.match(res.content[0].text, /disabled/);
  assert.equal(calls.length, 0);
});

test("gated tool blocked on user deny, with note", async () => {
  const calls: any[] = [];
  const t = gateToolDefinition(fakeTool("send", calls), policy, denyAll, noFollowUp);
  const res: any = await t.execute("1", {});
  assert.match(res.content[0].text, /NOT DONE/);
  assert.match(res.content[0].text, /nope/);
  assert.equal(calls.length, 0);
});

test("gated tool runs on approval; note delivered as follow-up; edited args used", async () => {
  const calls: any[] = [];
  const followUps: string[] = [];
  const approve: RequestApproval = async () => ({ decision: "allow", note: "ok cc boss", editedInput: { a: 2 } });
  const t = gateToolDefinition(fakeTool("send", calls), policy, approve, () => ({ followUp: async (x) => { followUps.push(x); } }));
  const res: any = await t.execute("1", { a: 1 });
  assert.equal(res.content[0].text, "RAN");
  assert.deepEqual(calls, [{ a: 2 }]);
  assert.deepEqual(followUps, ["User note: ok cc boss"]);
});
