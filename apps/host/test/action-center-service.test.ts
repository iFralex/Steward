import assert from "node:assert/strict";
import { test } from "node:test";
import { executableSteps, normalizeStep, notifyNewProposals, setPushRegistry, shouldRetryWithRevision } from "../src/core/action-center-service.ts";
import { ActionStore } from "../../action-center/src/store.ts";
import { PushRegistry, type SendFn } from "../src/core/push.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionCenterItem } from "@steward/protocol";

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

test("new Action proposals are pushed once while pre-existing Actions only seed the baseline", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "action-push-"));
  t.after(() => {
    setPushRegistry(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const sent: Record<string, unknown>[] = [];
  const send: SendFn = async (_subscription, payload) => { sent.push(JSON.parse(payload) as Record<string, unknown>); };
  const registry = new PushRegistry(join(dir, "subscriptions.json"), send);
  registry.subscribe({ endpoint: "https://push.example/device", keys: { p256dh: "p", auth: "a" } });
  setPushRegistry(registry);

  const store = ActionStore.open(":memory:");
  t.after(() => store.close());
  store.upsert({
    sourceKey: "mail:old",
    sourceKind: "mail",
    kind: "admin-task",
    title: "Existing Action",
    summary: "This predates push notifications.",
    payload: { proposedActions: [{ id: "old", label: "Old", summary: "Old", steps: [] }] },
  });
  await notifyNewProposals(store, store.list({ includeDone: true }) as ActionCenterItem[]);
  assert.equal(sent.length, 0, "the migration baseline must not flood existing Actions");

  const fresh = store.upsert({
    sourceKey: "mail:new",
    sourceKind: "mail",
    kind: "document-action",
    title: "Nuovo documento disponibile",
    summary: "Apri il documento.",
    payload: { proposedActions: [{ id: "open", label: "Apri", summary: "Apri", steps: [] }] },
  });
  const items = store.list({ includeDone: true }) as ActionCenterItem[];
  await notifyNewProposals(store, items);
  await notifyNewProposals(store, items);

  assert.equal(sent.length, 1, "the same Action must never produce duplicate pushes");
  assert.equal(sent[0].actionId, fresh.id);
  assert.equal(sent[0].body, "Nuovo documento disponibile");
  assert.equal(sent[0].tag, `action-${fresh.id}`);
});
