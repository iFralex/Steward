import { test } from "node:test";
import assert from "node:assert/strict";
import { gateToolDefinition, type RequestApproval } from "../src/core/permission-gate.ts";
import type { ToolPolicy } from "../src/core/tool-policy.ts";
import { buildWatchTools } from "../src/core/watch-tools.ts";

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
  const res: any = await t.execute("1", { a: 1 }, undefined, undefined, {} as any);
  assert.equal(res.content[0].text, "RAN");
  assert.deepEqual(calls, [{ a: 1 }]);
});

test("deny tool never runs", async () => {
  const calls: any[] = [];
  const t = gateToolDefinition(fakeTool("banned", calls), policy, denyAll, noFollowUp);
  const res: any = await t.execute("1", {}, undefined, undefined, {} as any);
  assert.match(res.content[0].text, /disabled/);
  assert.equal(calls.length, 0);
});

test("gated tool blocked on user deny, with note", async () => {
  const calls: any[] = [];
  const t = gateToolDefinition(fakeTool("send", calls), policy, denyAll, noFollowUp);
  const res: any = await t.execute("1", {}, undefined, undefined, {} as any);
  assert.match(res.content[0].text, /NOT DONE/);
  assert.match(res.content[0].text, /nope/);
  assert.equal(calls.length, 0);
});

test("gated tool asks model to revise on user revise", async () => {
  const calls: any[] = [];
  const revise: RequestApproval = async () => ({ decision: "revise", note: "usa ferie e scusati per il ritardo" });
  const t = gateToolDefinition(fakeTool("send", calls), policy, revise, noFollowUp);
  const res: any = await t.execute("1", { body: "old" }, undefined, undefined, {} as any);
  assert.match(res.content[0].text, /user requested a revision/);
  assert.match(res.content[0].text, /usa ferie/);
  assert.equal(calls.length, 0);
});

test("gated tool runs on approval; note delivered as follow-up; edited args used", async () => {
  const calls: any[] = [];
  const followUps: string[] = [];
  const approve: RequestApproval = async () => ({ decision: "allow", note: "ok cc boss", editedInput: { a: 2 } });
  const t = gateToolDefinition(fakeTool("send", calls), policy, approve, () => ({ followUp: async (x) => { followUps.push(x); } }));
  const res: any = await t.execute("1", { a: 1 }, undefined, undefined, {} as any);
  assert.equal(res.content[0].text, "RAN");
  assert.deepEqual(calls, [{ a: 2 }]);
  assert.deepEqual(followUps, ["User note: ok cc boss"]);
});

test("gated tool's requestApproval receives the chatId it was constructed with", async () => {
  const calls: any[] = [];
  const captured: any[] = [];
  const capture: RequestApproval = async (req) => {
    captured.push(req);
    return { decision: "allow" };
  };
  // Mirrors how ChatManager.ensureChat builds a per-chat requestApproval:
  // a closure over the chat's own chatId, tagging every approval request.
  const chatBoundRequestApproval: RequestApproval = (req) => capture({ ...req, chatId: "chat-1" });
  const t = gateToolDefinition(fakeTool("send", calls), policy, chatBoundRequestApproval, noFollowUp);
  await t.execute("1", { a: 1 }, undefined, undefined, {} as any);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].chatId, "chat-1");
  assert.equal(captured[0].tool, "send");
  assert.deepEqual(captured[0].input, { a: 1 });
});

test("an execution guard runs after policy and can block or finalize an allowed tool", async () => {
  const calls: any[] = [];
  const events: string[] = [];
  const denied = gateToolDefinition(fakeTool("read", calls), policy, denyAll, noFollowUp, undefined, {
    beforeExecute: async () => ({ allowed: false, reason: "outside grant" }),
  });
  const blocked: any = await denied.execute("1", { a: 1 }, undefined, undefined, {} as any);
  assert.match(blocked.content[0].text, /outside grant/);
  assert.equal(calls.length, 0);

  const allowed = gateToolDefinition(fakeTool("read", calls), policy, denyAll, noFollowUp, undefined, {
    beforeExecute: async () => ({ allowed: true }),
    afterExecute: async (_tool, input, error) => { events.push(`${JSON.stringify(input)}:${error ?? "ok"}`); },
  });
  await allowed.execute("2", { a: 2 }, undefined, undefined, {} as any);
  assert.deepEqual(calls, [{ a: 2 }]);
  assert.deepEqual(events, ['{"a":2}:ok']);
});

test("watch input is validated before approval and invalid grants never prompt", async () => {
  let approvals = 0;
  const request: RequestApproval = async () => { approvals += 1; return { decision: "deny" }; };
  const def = buildWatchTools("chat-1").find((tool) => tool.name === "create_agent_watch")!;
  const gated = gateToolDefinition(def, policy, request, noFollowUp);
  await assert.rejects(() => gated.execute("watch-invalid", {
    source: "time", afterMinutes: 2, instruction: "Chiama",
    rules: [{ id: "call", event: "time.reached", once: true,
      grants: [{ tool: "mcp__voice__call_start", constraints: { fields: {
        opening_line: { kind: "exact", value: "Ciao" },
      }, denyExtraFields: true } }],
    }],
  }, undefined, undefined, {} as any), /does not accept watch constraints/);
  assert.equal(approvals, 0);
});

test("relative watch delay is frozen to an absolute instant before approval", async () => {
  let approvedInput: Record<string, unknown> | undefined;
  const request: RequestApproval = async (req) => {
    approvedInput = req.input;
    return { decision: "deny", failureKind: "explicit-deny" };
  };
  const def = buildWatchTools("chat-1").find((tool) => tool.name === "create_agent_watch")!;
  const gated = gateToolDefinition(def, policy, request, noFollowUp);
  const before = Date.now() + 2 * 60_000;
  await gated.execute("watch-relative", {
    source: "time", afterMinutes: 2, instruction: "Chiama",
    rules: [{ id: "call", event: "time.reached", once: true,
      grants: [{ tool: "mcp__voice__call_start", maxInvocations: 1 }],
    }],
  }, undefined, undefined, {} as any);
  const after = Date.now() + 2 * 60_000;
  assert.equal(approvedInput?.afterMinutes, undefined);
  const at = Date.parse(String(approvedInput?.at));
  assert.ok(at >= before && at <= after);
});

test("an unrecognized approval is not reported to the model as a user rejection", async () => {
  const calls: any[] = [];
  const unavailable: RequestApproval = async () => ({
    decision: "deny", failureKind: "unrecognized", note: "No valid command was recognized",
  });
  const t = gateToolDefinition(fakeTool("send", calls), policy, unavailable, noFollowUp);
  const res: any = await t.execute("1", {}, undefined, undefined, {} as any);
  assert.match(res.content[0].text, /approval could not be obtained/);
  assert.doesNotMatch(res.content[0].text, /denied by user/);
  assert.equal(res.details.stewardOutcome, "blocked");
});
