import { recordAudit } from "@steward/audit-log";
import type { PendingWatchEvent, WatchFieldConstraint, WatchStore, WatchToolConstraints } from "@steward/watch-engine";
import type { ToolExecutionGuard } from "./permission-gate.ts";
import { normalizeStoredWatchGrant, watchCapability } from "./watch-capabilities.ts";

export interface ResolvedWatchGrant {
  ruleId: string;
  tool: string;
  maxInvocations: number;
  constraints?: WatchToolConstraints;
  error?: string;
}

export function resolvedWatchGrants(pending: PendingWatchEvent): ResolvedWatchGrant[] {
  return pending.rules.flatMap((rule) => (rule.grants ?? []).map((stored) => {
    try {
      const grant = normalizeStoredWatchGrant(stored);
      const constraints = grant.constraints ? resolveConstraints(grant.constraints, pending) : undefined;
      return { ruleId: rule.id, tool: grant.tool, maxInvocations: grant.maxInvocations ?? 1, ...(constraints ? { constraints } : {}) };
    } catch (error) {
      return {
        ruleId: rule.id, tool: typeof stored.tool === "string" ? stored.tool : "invalid",
        maxInvocations: 0, error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

export function watchHasGrant(pending: PendingWatchEvent, tool: string): boolean {
  return resolvedWatchGrants(pending).some((grant) => grant.tool === tool && !grant.error);
}

export function watchAgentGrantTools(pending: PendingWatchEvent): string[] {
  return [...new Set(resolvedWatchGrants(pending)
    .filter((grant) => !grant.error && watchCapability(grant.tool)?.mode === "agent")
    .map((grant) => grant.tool))];
}

/** Generic deterministic constraint enforcement plus durable at-most-once
 * claiming. Read-only tools still pass through the ordinary background policy. */
export function createWatchExecutionGuard(pending: PendingWatchEvent, store: WatchStore): ToolExecutionGuard {
  const grants = resolvedWatchGrants(pending);
  const claimed = new Map<string, string>();
  return {
    async beforeExecute(tool, input) {
      const capability = watchCapability(tool);
      if (!capability) return { allowed: true };
      const grant = grants.find((candidate) => !candidate.error && candidate.tool === tool
        && (!capability.constraintsRequired || matchesConstraints(candidate.constraints, input)));
      if (!grant) {
        audit(pending, "watch.grant_denied", "Watch tool arguments exceeded the approved constraints", false, { tool, input });
        return { allowed: false, reason: `${tool} was not executed: its arguments differ from this event's approved constraints.` };
      }
      if (!store.claimAction(pending.id, grant.ruleId, tool)) {
        audit(pending, "watch.grant_duplicate_blocked", "Blocked a repeated watch action", false, { tool, ruleId: grant.ruleId });
        return { allowed: false, reason: `${tool} was not executed again: this watch action was already attempted.` };
      }
      claimed.set(claimKey(tool, input), grant.ruleId);
      audit(pending, "watch.grant_claimed", "Claimed a pre-authorized watch action", true, { tool, ruleId: grant.ruleId, input });
      return { allowed: true };
    },
    async afterExecute(tool, input, error) {
      const key = claimKey(tool, input);
      const ruleId = claimed.get(key);
      if (!ruleId) return;
      store.finishAction(pending.id, ruleId, tool, error);
      audit(pending, error ? "watch.action_failed" : "watch.action_completed", error ?? "Pre-authorized watch action completed", !error, { tool, ruleId });
      claimed.delete(key);
    },
  };
}

function resolveConstraints(constraints: WatchToolConstraints, pending: PendingWatchEvent): WatchToolConstraints {
  return {
    ...constraints,
    fields: Object.fromEntries(Object.entries(constraints.fields).map(([field, constraint]) => [field, resolveConstraint(constraint, pending)])),
  };
}

function resolveConstraint(constraint: WatchFieldConstraint, pending: PendingWatchEvent): WatchFieldConstraint {
  if (constraint.kind !== "template") return constraint;
  return { kind: "exact", value: renderTemplate(constraint.template, pending) };
}

function renderTemplate(template: string, pending: PendingWatchEvent): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, reference: string) => {
    const value = reference.startsWith("state.")
      ? readPath(pending.event.currentState, reference.slice("state.".length))
      : reference.startsWith("event.")
        ? readPath(pending.event, reference.slice("event.".length))
        : undefined;
    if (value === undefined || value === null) throw new Error(`Watch template value is unavailable: ${reference}`);
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function matchesConstraints(constraints: WatchToolConstraints | undefined, input: Record<string, unknown>): boolean {
  if (!constraints) return Object.keys(input).length === 0;
  const constrainedFields = Object.keys(constraints.fields);
  const inputFields = Object.keys(input);
  if (constraints.denyExtraFields && inputFields.some((field) => !constrainedFields.includes(field))) return false;
  if (constrainedFields.some((field) => !(field in input))) return false;
  return Object.entries(constraints.fields).every(([field, constraint]) => matchesField(constraint, input[field]));
}

function matchesField(constraint: WatchFieldConstraint, actual: unknown): boolean {
  if (constraint.kind === "exact") return deepEqual(constraint.value, actual);
  if (constraint.kind === "one_of") return constraint.values.some((value) => deepEqual(value, actual));
  if (constraint.kind === "range") {
    return typeof actual === "number" && Number.isFinite(actual)
      && (constraint.min === undefined || actual >= constraint.min)
      && (constraint.max === undefined || actual <= constraint.max);
  }
  return false;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
}

function claimKey(tool: string, input: Record<string, unknown>): string {
  return `${tool}:${JSON.stringify(canonical(input))}`;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function audit(
  pending: PendingWatchEvent,
  eventType: string,
  summary: string,
  ok: boolean,
  payload: Record<string, unknown>,
): void {
  recordAudit({
    actor: "host", eventType, risk: ok ? "low" : "high", summary, ok,
    chatId: pending.chatId, correlationId: pending.watchId,
    payload: { watchId: pending.watchId, eventId: pending.id, ...payload },
    sourceRefs: [{ type: "watch", id: pending.watchId, label: pending.event.type }],
  });
}
