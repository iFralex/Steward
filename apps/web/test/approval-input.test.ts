import assert from "node:assert/strict";
import test from "node:test";
import { buildEditedApprovalInput, toEditable, type ApprovalField } from "../src/lib/approval-input.ts";

const calendarFields: ApprovalField[] = [
  { key: "summary", labelKey: "title", kind: "text" },
  { key: "allDay", labelKey: "allDay", kind: "bool" },
  { key: "alarms", labelKey: "alarms", kind: "numbers" },
];

function initialValues(input: Record<string, unknown>): Record<string, string | boolean> {
  return Object.fromEntries(calendarFields.map((field) => [field.key, toEditable(field.kind, input[field.key])]));
}

test("untouched optional calendar fields stay absent", () => {
  const input = { uid: "U1", summary: "Demo" };
  assert.deepEqual(buildEditedApprovalInput(input, calendarFields, initialValues(input)), input);
});

test("explicit booleans and arrays retain their values", () => {
  const input = { summary: "Demo", allDay: false, alarms: [] };
  assert.deepEqual(buildEditedApprovalInput(input, calendarFields, initialValues(input)), input);
});

test("editing alarms creates or clears the field deliberately", () => {
  const absent = { uid: "U1", summary: "Demo" };
  assert.deepEqual(
    buildEditedApprovalInput(absent, calendarFields, { ...initialValues(absent), alarms: "10, 60" }),
    { ...absent, alarms: [10, 60] },
  );

  const existing = { uid: "U1", summary: "Demo", alarms: [10] };
  assert.deepEqual(
    buildEditedApprovalInput(existing, calendarFields, { ...initialValues(existing), alarms: "" }),
    { ...existing, alarms: [] },
  );
});
