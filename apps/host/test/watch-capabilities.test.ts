import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeStoredWatchGrant, parseWatchGrant, watchCapabilityNames } from "../src/core/watch-capabilities.ts";

test("the capability registry accepts generic calendar constraints", () => {
  const grant = parseWatchGrant({
    tool: "mcp__calendar__create_event", maxInvocations: 1,
    constraints: { denyExtraFields: true, fields: {
      calendar: { kind: "one_of", values: ["Personale", "Lavoro"] },
      summary: { kind: "exact", value: "Arrivo" },
      start: { kind: "template", template: "{{state.estimatedArrival}}" },
      end: { kind: "template", template: "{{event.data.appointmentEnd}}" },
      alarms: { kind: "exact", value: [15] },
    } },
  });
  assert.equal(grant.tool, "mcp__calendar__create_event");
  assert.equal(grant.constraints?.fields.calendar.kind, "one_of");
  assert.ok(watchCapabilityNames().includes("mcp__contacts__update_contact"));
});

test("unknown tools and under-constrained writes are rejected", () => {
  assert.throws(() => parseWatchGrant({ tool: "mcp__shell__run_write_command", maxInvocations: 1 }), /Unsupported watch capability/);
  assert.throws(() => parseWatchGrant({
    tool: "mcp__calendar__delete_event",
    constraints: { denyExtraFields: false, fields: { uid: { kind: "exact", value: "x" } } },
  }), /denyExtraFields=true/);
  assert.throws(() => parseWatchGrant({
    tool: "mcp__calendar__create_event",
    constraints: { denyExtraFields: true, fields: { summary: { kind: "exact", value: "x" } } },
  }), /requires constrained field/);
  assert.throws(() => parseWatchGrant({
    tool: "mcp__action-center__mark_action",
    constraints: { denyExtraFields: true, fields: {
      id: { kind: "template", template: "{{user.prompt}}" }, status: { kind: "exact", value: "done" },
    } },
  }), /Unsupported watch template reference/);
});

test("legacy exact-mail grants are migrated when a queued watch is read", () => {
  const migrated = normalizeStoredWatchGrant({
    tool: "mcp__mail__send_email", maxInvocations: 1,
    constraints: { to: ["sister@example.com"], subject: "Arrivo", bodyTemplate: "Alle {{estimatedArrival}}" },
  } as any);
  assert.deepEqual(migrated.constraints, {
    denyExtraFields: true,
    fields: {
      to: { kind: "exact", value: ["sister@example.com"] },
      subject: { kind: "exact", value: "Arrivo" },
      body: { kind: "template", template: "Alle {{state.estimatedArrival}}" },
    },
  });
});
