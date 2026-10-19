import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/core/session.ts";
import type { ServerEvent } from "@steward/protocol";

type QReq = Extract<ServerEvent, { type: "question_request" }>;
type AReq = Extract<ServerEvent, { type: "approval_request" }>;
const firstQuestion = (events: ServerEvent[]) => events.find((e) => e.type === "question_request") as QReq | undefined;

test("editing renews approval inactivity without affecting other requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: ServerEvent[] = [];
  const s = new Session((e) => events.push(e), 600_000);
  let resolved = false;
  const pending = s.requestApproval({ tool: "send_email", input: { body: "original" } });
  void pending.then(() => { resolved = true; });
  const other = s.requestApproval({ tool: "create_event", input: {} });
  const requests = events.filter((e) => e.type === "approval_request") as AReq[];
  t.mock.timers.tick(540_000);
  assert.equal(s.touchApproval(requests[0].requestId), true);
  t.mock.timers.tick(60_000);
  assert.equal((await other).failureKind, "timeout");
  await Promise.resolve();
  assert.equal(resolved, false);
  t.mock.timers.tick(539_999);
  await Promise.resolve();
  assert.equal(resolved, false);
  t.mock.timers.tick(1);
  assert.equal((await pending).failureKind, "timeout");
  assert.equal(s.touchApproval(requests[0].requestId), false);
  assert.equal(s.resolveApproval(requests[0].requestId, { decision: "allow" }), false);
});

test("renewed approval executes edited input only after an explicit decision", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: ServerEvent[] = [];
  const s = new Session((e) => events.push(e), 600_000);
  const pending = s.requestApproval({ tool: "send_email", input: { body: "original" } });
  const req = events[0] as AReq;
  assert.equal(s.touchApproval("unknown"), false);
  t.mock.timers.tick(540_000);
  assert.equal(s.touchApproval(req.requestId), true);
  t.mock.timers.tick(120_000);
  const outcome = { decision: "allow" as const, editedInput: { body: "edited" } };
  assert.equal(s.resolveApproval(req.requestId, outcome), true);
  assert.deepEqual(await pending, outcome);
  assert.equal(s.touchApproval(req.requestId), false);
  t.mock.timers.tick(600_000);
  assert.equal(s.resolveApproval(req.requestId, outcome), false);
});

test("approval preview is emitted separately from executable input", async () => {
  const events: ServerEvent[] = [];
  const s = new Session((e) => events.push(e), 60_000);
  const pending = s.requestApproval({
    tool: "mcp__calendar__delete_event",
    input: { uid: "UID-9" },
    preview: { uid: "UID-9", summary: "Deep learning" },
  });
  const req = events.find((event) => event.type === "approval_request") as AReq;
  assert.deepEqual(req.input, { uid: "UID-9" });
  assert.deepEqual(req.preview, { uid: "UID-9", summary: "Deep learning" });
  s.resolveApproval(req.requestId, { decision: "allow" });
  assert.deepEqual(await pending, { decision: "allow" });
});

test("askQuestion emits a question_request and resolves on question_response", async () => {
  const events: ServerEvent[] = [];
  const s = new Session((e) => events.push(e), 60_000);
  const p = s.askQuestion({ question: "Quale?", options: ["A", "B"], multiSelect: false });
  const req = firstQuestion(events);
  assert.ok(req, "a question_request was emitted");
  assert.equal(req.question, "Quale?");
  assert.deepEqual(req.options, ["A", "B"]);
  assert.equal(req.multiSelect, false);
  assert.equal(s.resolveQuestion(req.requestId, ["B"]), true);
  assert.deepEqual(await p, ["B"]);
});

test("multi-select question returns all selected labels", async () => {
  const events: ServerEvent[] = [];
  const s = new Session((e) => events.push(e), 60_000);
  const p = s.askQuestion({ question: "q", options: ["A", "B", "C"], multiSelect: true });
  const req = firstQuestion(events)!;
  s.resolveQuestion(req.requestId, ["A", "C"]);
  assert.deepEqual(await p, ["A", "C"]);
});

test("askQuestion times out to an empty selection", async () => {
  const s = new Session(() => {}, 5); // 5ms
  assert.deepEqual(await s.askQuestion({ question: "q", options: ["A", "B"], multiSelect: false }), []);
});

test("resolveQuestion returns false for an unknown requestId", () => {
  const s = new Session(() => {}, 60_000);
  assert.equal(s.resolveQuestion("nope", ["X"]), false);
});
