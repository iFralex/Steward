import assert from "node:assert/strict";
import { test } from "node:test";
import { executableSteps, normalizeStep, shouldRetryWithRevision } from "../src/core/action-center-service.ts";

test("normalizeStep parses a legacy step with no kind as a tool step", () => {
  const step = normalizeStep({ id: "s1", label: "Reply", tool: "mcp__mail__reply", input: { to: "a@b.com" }, writes: true });
  assert.ok(step);
  assert.equal(step!.kind, "tool");
  assert.equal((step as { tool: string }).tool, "mcp__mail__reply");
});

test("normalizeStep parses a manual step and preserves its links", () => {
  const step = normalizeStep({
    id: "m1",
    label: "Carica il documento",
    kind: "manual",
    links: [{ url: "https://portal.example/upload", label: "Apri portale" }],
  });
  assert.ok(step);
  assert.equal(step!.kind, "manual");
  assert.deepEqual((step as { links?: unknown[] }).links, [{ url: "https://portal.example/upload", label: "Apri portale" }]);
});

test("normalizeStep drops a manual step's malformed links but keeps the step", () => {
  const step = normalizeStep({ id: "m2", label: "Fai qualcosa", kind: "manual", links: "not-an-array" });
  assert.ok(step);
  assert.equal(step!.kind, "manual");
  assert.deepEqual((step as { links?: unknown[] }).links, []);
});

test("normalizeStep rejects a non-manual step with no tool", () => {
  const step = normalizeStep({ id: "bad", label: "Nothing" });
  assert.equal(step, null);
});

test("executableSteps keeps only tool steps, in order, dropping manual ones", () => {
  const steps = [
    normalizeStep({ id: "reply", label: "Reply", tool: "mcp__mail__reply", input: {}, writes: true }),
    normalizeStep({ id: "upload", label: "Upload", kind: "manual", links: [{ url: "https://portal.example/x" }] }),
    normalizeStep({ id: "event", label: "Create event", tool: "mcp__calendar__create_event", input: {}, writes: true }),
  ].filter((s): s is NonNullable<typeof s> => !!s);

  const result = executableSteps(steps);
  assert.deepEqual(result.map((s) => s.id), ["reply", "event"]);
});

test("executableSteps returns an empty array for an all-manual proposal", () => {
  const steps = [
    normalizeStep({ id: "upload", label: "Upload", kind: "manual", links: [{ url: "https://portal.example/x" }] }),
  ].filter((s): s is NonNullable<typeof s> => !!s);

  assert.deepEqual(executableSteps(steps), []);
});

test("shouldRetryWithRevision is true for an explicit revise decision", () => {
  assert.equal(shouldRetryWithRevision({ decision: "revise", note: "usa ferie" }), true);
  assert.equal(shouldRetryWithRevision({ decision: "revise" }), true);
});

test("shouldRetryWithRevision is true for a deny that carries a non-empty note", () => {
  assert.equal(shouldRetryWithRevision({ decision: "deny", note: "manda invece a Marco" }), true);
});

test("shouldRetryWithRevision is false for a bare deny with no note", () => {
  assert.equal(shouldRetryWithRevision({ decision: "deny" }), false);
  assert.equal(shouldRetryWithRevision({ decision: "deny", note: "   " }), false);
});

test("shouldRetryWithRevision is false for allow", () => {
  assert.equal(shouldRetryWithRevision({ decision: "allow", note: "anything" }), false);
});
