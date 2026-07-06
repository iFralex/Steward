import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AUDIT_DIR = mkdtempSync(join(tmpdir(), "write-ops-audit-test-"));
import { test } from "node:test";
import { WriteOpsStore } from "../src/index.ts";
import { auditLog, type AuditActor } from "@steward/audit-log";

const mk = (actor?: AuditActor) => WriteOpsStore.open(":memory:", actor);
const op = { kind: "mail.send" as const, input: { to: ["a@b.co"], subject: "x", body: "hi" }, expected: { bodySnippet: "hi" } };

test("startScheduled enqueues and lists; dueScheduled gates on time", () => {
  const s = mk();
  const now = Math.floor(Date.now() / 1000);
  const id = s.startScheduled(op, now + 3600);
  assert.equal(s.listScheduled().length, 1);
  assert.equal(s.listScheduled()[0].id, id);
  assert.equal(s.listScheduled()[0].scheduledFor, now + 3600);
  assert.equal(s.dueScheduled(now).length, 0, "not due yet");
  assert.equal(s.dueScheduled(now + 3600).length, 1, "due once its time arrives");
  s.close();
});

test("cancelScheduled removes a pending op; returns false once fired", () => {
  const s = mk();
  const now = Math.floor(Date.now() / 1000);
  const id = s.startScheduled(op, now);
  assert.equal(s.cancelScheduled(id), true);
  assert.equal(s.listScheduled().length, 0);
  const id2 = s.startScheduled(op, now);
  s.scriptReturned(id2);
  assert.equal(s.cancelScheduled(id2), false, "a fired op is no longer cancellable");
  s.close();
});

test("a fired scheduled op flows into the confirmation queue", () => {
  const s = mk();
  const id = s.startScheduled(op, Math.floor(Date.now() / 1000));
  s.scriptReturned(id, { scheduled: true });
  assert.equal(s.listScheduled().length, 0);
  const pending = s.pendingForConfirmation(["mail.send"]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, id);
  s.close();
});

test("audit events are attributed to the store's actor, not always 'host'", () => {
  const host = mk(); // default
  const hostId = host.start(op);
  host.close();
  const hostEvent = auditLog().query({ eventType: "write.started" }).events.find((e) => e.correlationId === hostId);
  assert.equal(hostEvent?.actor, "host");

  const scheduler = mk("scheduler");
  const schedulerId = scheduler.startScheduled(op, Math.floor(Date.now() / 1000));
  scheduler.scriptReturned(schedulerId, { scheduled: true });
  scheduler.close();
  const scheduledEvent = auditLog().query({ eventType: "write.scheduled" }).events.find((e) => e.correlationId === schedulerId);
  const returnedEvent = auditLog().query({ eventType: "write.script_returned" }).events.find((e) => e.correlationId === schedulerId);
  assert.equal(scheduledEvent?.actor, "scheduler");
  assert.equal(returnedEvent?.actor, "scheduler");
});
