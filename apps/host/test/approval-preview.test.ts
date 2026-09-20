import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApprovalPreview } from "../src/core/approval-preview.ts";

test("delete_event approval is enriched with the event being deleted", async () => {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const input = { uid: "UID-9" };
  const preview = await buildApprovalPreview("mcp__calendar__delete_event", input, async (tool, args) => {
    calls.push({ tool, input: args });
    return [{ type: "text", text: JSON.stringify({ uid: "UID-9", summary: "Deep learning", start: "2026-09-17T14:15:00Z", calendar: "Calendario" }) }];
  });

  assert.deepEqual(calls, [{ tool: "mcp__calendar__read_event", input: { uid: "UID-9" } }]);
  assert.deepEqual(preview, {
    uid: "UID-9",
    summary: "Deep learning",
    start: "2026-09-17T14:15:00Z",
    calendar: "Calendario",
  });
  assert.deepEqual(input, { uid: "UID-9" }, "the write-tool input must not be mutated");
});

test("preview lookup failure does not alter or block the approval", async () => {
  const input = { uid: "UID-9" };
  const preview = await buildApprovalPreview("mcp__calendar__delete_event", input, async () => {
    throw new Error("calendar unavailable");
  });
  assert.equal(preview, undefined);
  assert.deepEqual(input, { uid: "UID-9" });
});

test("update_event preview contains the current event while keeping the patch separate", async () => {
  const input = { uid: "UID-9", location: "Room 2" };
  const preview = await buildApprovalPreview("mcp__calendar__update_event", input, async () => [
    { type: "text", text: JSON.stringify({ uid: "UID-9", summary: "Deep learning", location: "Room 1" }) },
  ]);
  assert.deepEqual(preview, { uid: "UID-9", summary: "Deep learning", location: "Room 1" });
  assert.deepEqual(input, { uid: "UID-9", location: "Room 2" });
});

test("reply preview derives recipient and subject from the original message", async () => {
  const preview = await buildApprovalPreview("mcp__mail__reply", { id: "42", body: "Thanks" }, async (tool, args) => {
    assert.equal(tool, "mcp__mail__read_message");
    assert.deepEqual(args, { id: "42" });
    return [{ type: "text", text: JSON.stringify({ from: "Ada <ada@example.com>", subject: "Hello", mailUrl: "message://42" }) }];
  });
  assert.deepEqual(preview, { to: ["Ada <ada@example.com>"], subject: "Hello", mailUrl: "message://42" });
});

test("agent watch approval previews every rule-scoped action and constraint", async () => {
  const rules = [{ id: "mail", trigger: { kind: "before_time", field: "estimatedArrivalMs", minutes: 30 }, once: true,
    grants: [{ tool: "mcp__mail__send_email", constraints: { to: ["sister@example.com"], subject: "Arrivo", bodyTemplate: "Sto arrivando" } }] }];
  const preview = await buildApprovalPreview("create_agent_watch", {
    source: "train", resourceRef: "ref", instruction: "Avvisala", rules,
  }, async () => { throw new Error("preview must not call another tool"); });
  assert.deepEqual(preview, { source: "train", resourceRef: "ref", instruction: "Avvisala", expiresAt: undefined, rules });
});
