import type { WatchFieldConstraint, WatchToolConstraints, WatchToolGrant } from "@steward/watch-engine";

export interface WatchCapabilityDefinition {
  tool: string;
  mode: "agent" | "voice";
  description: string;
  allowedFields: readonly string[];
  requiredFields?: readonly string[];
  requireAnyFields?: readonly string[];
  constraintsRequired: boolean;
  maxInvocations: number;
}

/** Explicit registry: the constraint engine is generic, but a newly connected
 * write tool is never pre-authorizable until its safe argument surface is
 * reviewed and registered here. */
export const WATCH_CAPABILITIES: readonly WatchCapabilityDefinition[] = [
  capability("mcp__voice__call_start", "voice", "Start one conversational phone call", [], false),
  capability("mcp__mail__send_email", "agent", "Send one exact email", ["from", "to", "cc", "bcc", "subject", "body", "attachments", "sendAt"], true, ["to", "subject", "body"]),
  capability("mcp__mail__reply", "agent", "Send one constrained email reply", ["id", "messageId", "from", "body", "attachments", "replyAll", "sendAt"], true, ["body"], ["id", "messageId"]),
  capability("mcp__calendar__create_event", "agent", "Create one constrained calendar event", ["calendar", "summary", "start", "end", "allDay", "location", "description", "url", "recurrence", "alarms"], true, ["calendar", "summary", "start", "end"]),
  capability("mcp__calendar__update_event", "agent", "Update one constrained calendar event", ["uid", "summary", "start", "end", "location", "description", "url", "recurrence", "alarms"], true, ["uid"]),
  capability("mcp__calendar__delete_event", "agent", "Delete one exact calendar event", ["uid"], true, ["uid"]),
  capability("mcp__contacts__create_contact", "agent", "Create one constrained contact", ["firstName", "lastName", "organization", "nickname", "note", "emails", "phones"], true, undefined, ["firstName", "lastName", "organization"]),
  capability("mcp__contacts__update_contact", "agent", "Update one constrained contact", ["personId", "firstName", "lastName", "organization", "nickname", "note", "emails", "phones"], true, ["personId"]),
  capability("mcp__action-center__mark_action", "agent", "Set one Action Center item status", ["id", "status"], true, ["id", "status"]),
];

const BY_TOOL = new Map(WATCH_CAPABILITIES.map((entry) => [entry.tool, entry]));

export function watchCapability(tool: string): WatchCapabilityDefinition | undefined {
  return BY_TOOL.get(tool);
}

export function watchCapabilityNames(): string[] {
  return WATCH_CAPABILITIES.map((entry) => entry.tool);
}

export function parseWatchGrant(value: unknown): WatchToolGrant {
  if (!isRecord(value)) throw new Error("Each grant must be an object");
  const tool = string(value.tool, "grant.tool");
  const definition = watchCapability(tool);
  if (!definition) throw new Error(`Unsupported watch capability ${tool}. Allowed: ${watchCapabilityNames().join(", ")}`);
  const maxInvocations = value.maxInvocations === undefined ? 1 : number(value.maxInvocations, "grant.maxInvocations");
  if (!Number.isInteger(maxInvocations) || maxInvocations < 1 || maxInvocations > definition.maxInvocations) {
    throw new Error(`${tool} permits at most ${definition.maxInvocations} invocation(s) per rule event`);
  }
  const constraints = value.constraints === undefined ? undefined : parseConstraints(value.constraints);
  validateGrant(definition, constraints);
  return { tool, maxInvocations, ...(constraints ? { constraints } : {}) };
}

/** Converts the one pre-registry mail shape already persisted by Steward. */
export function normalizeStoredWatchGrant(grant: WatchToolGrant): WatchToolGrant {
  const raw = grant as unknown as { tool?: unknown; maxInvocations?: unknown; constraints?: unknown };
  if (raw.tool === "mcp__mail__send_email" && isRecord(raw.constraints)
    && Array.isArray(raw.constraints.to) && typeof raw.constraints.subject === "string" && typeof raw.constraints.bodyTemplate === "string") {
    return {
      tool: raw.tool, maxInvocations: 1,
      constraints: {
        denyExtraFields: true,
        fields: {
          to: { kind: "exact", value: raw.constraints.to },
          subject: { kind: "exact", value: raw.constraints.subject },
          body: { kind: "template", template: legacyTemplate(raw.constraints.bodyTemplate) },
        },
      },
    };
  }
  return parseWatchGrant(raw);
}

function validateGrant(definition: WatchCapabilityDefinition, constraints: WatchToolConstraints | undefined): void {
  if (!definition.constraintsRequired) {
    if (constraints && Object.keys(constraints.fields).length) throw new Error(`${definition.tool} does not accept watch constraints`);
    return;
  }
  if (!constraints) throw new Error(`${definition.tool} requires argument constraints`);
  if (constraints.denyExtraFields !== true) throw new Error(`${definition.tool} requires denyExtraFields=true`);
  const fields = Object.keys(constraints.fields);
  const unknown = fields.filter((field) => !definition.allowedFields.includes(field));
  if (unknown.length) throw new Error(`${definition.tool} cannot constrain unsupported field(s): ${unknown.join(", ")}`);
  const missing = (definition.requiredFields ?? []).filter((field) => !fields.includes(field));
  if (missing.length) throw new Error(`${definition.tool} requires constrained field(s): ${missing.join(", ")}`);
  if (definition.requireAnyFields?.length && !definition.requireAnyFields.some((field) => fields.includes(field))) {
    throw new Error(`${definition.tool} requires one of: ${definition.requireAnyFields.join(", ")}`);
  }
}

function parseConstraints(value: unknown): WatchToolConstraints {
  if (!isRecord(value) || !isRecord(value.fields)) throw new Error("grant.constraints.fields must be an object");
  const fields = Object.fromEntries(Object.entries(value.fields).map(([name, constraint]) => [name, parseFieldConstraint(name, constraint)]));
  return { fields, ...(value.denyExtraFields === true ? { denyExtraFields: true } : {}) };
}

function parseFieldConstraint(field: string, value: unknown): WatchFieldConstraint {
  if (!isRecord(value) || typeof value.kind !== "string") throw new Error(`Constraint for ${field} requires kind`);
  if (value.kind === "exact") {
    if (!("value" in value)) throw new Error(`Exact constraint for ${field} requires value`);
    return { kind: "exact", value: value.value };
  }
  if (value.kind === "template") {
    const template = string(value.template, `template constraint for ${field}`);
    validateTemplate(template);
    return { kind: "template", template };
  }
  if (value.kind === "one_of") {
    if (!Array.isArray(value.values) || !value.values.length) throw new Error(`one_of constraint for ${field} requires values`);
    return { kind: "one_of", values: value.values };
  }
  if (value.kind === "range") {
    const min = value.min === undefined ? undefined : number(value.min, `${field}.min`);
    const max = value.max === undefined ? undefined : number(value.max, `${field}.max`);
    if (min === undefined && max === undefined) throw new Error(`range constraint for ${field} requires min or max`);
    if (min !== undefined && max !== undefined && min > max) throw new Error(`range constraint for ${field} has min > max`);
    return { kind: "range", ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  throw new Error(`Unsupported constraint kind for ${field}`);
}

function validateTemplate(template: string): void {
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    if (!/^(state|event\.data|event)\.[A-Za-z0-9_.-]+$/.test(match[1])) throw new Error(`Unsupported watch template reference: ${match[1]}`);
  }
  const withoutValid = template.replace(/\{\{\s*[^{}]+?\s*\}\}/g, "");
  if (withoutValid.includes("{{") || withoutValid.includes("}}")) throw new Error("Malformed watch template");
}

function legacyTemplate(template: string): string {
  return template.replace(/\{\{(estimatedArrival|delayMinutes|destination|trainNumber)\}\}/g, "{{state.$1}}");
}

function capability(
  tool: string,
  mode: WatchCapabilityDefinition["mode"],
  description: string,
  allowedFields: readonly string[],
  constraintsRequired: boolean,
  requiredFields?: readonly string[],
  requireAnyFields?: readonly string[],
): WatchCapabilityDefinition {
  return { tool, mode, description, allowedFields, constraintsRequired, requiredFields, requireAnyFields, maxInvocations: 1 };
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
