import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/core/session.ts";
import type { ServerEvent } from "@steward/protocol";

type QReq = Extract<ServerEvent, { type: "question_request" }>;
type AReq = Extract<ServerEvent, { type: "approval_request" }>;
const firstQuestion = (events: ServerEvent[]) => events.find((e) => e.type === "question_request") as QReq | undefined;

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
