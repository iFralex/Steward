import { recordAudit } from "@steward/audit-log";
import type { PendingWatchEvent, WatchStore, WatchToolGrant } from "@steward/watch-engine";
import type { ToolExecutionGuard } from "./permission-gate.ts";

interface ResolvedGrant {
  ruleId: string;
  tool: WatchToolGrant["tool"];
  input?: Record<string, unknown>;
}

export function resolvedWatchGrants(pending: PendingWatchEvent): ResolvedGrant[] {
  return pending.rules.flatMap((rule) => (rule.grants ?? []).map((grant) => {
    if (grant.tool === "mcp__voice__call_start") return { ruleId: rule.id, tool: grant.tool };
    return {
      ruleId: rule.id,
      tool: grant.tool,
      input: {
        to: grant.constraints.to,
        subject: grant.constraints.subject,
        body: renderTemplate(grant.constraints.bodyTemplate, pending),
      },
    };
  }));
}

export function watchHasGrant(pending: PendingWatchEvent, tool: WatchToolGrant["tool"]): boolean {
  return resolvedWatchGrants(pending).some((grant) => grant.tool === tool);
}

/** Enforces exact rule-scoped arguments and durable at-most-once execution. */
export function createWatchExecutionGuard(pending: PendingWatchEvent, store: WatchStore): ToolExecutionGuard {
  const grants = resolvedWatchGrants(pending);
  const claimed = new Map<string, string>();
  return {
    async beforeExecute(tool, input) {
      // Read-only tools are governed by the background policy. This guard adds
      // a second boundary only for capabilities granted by a watch rule.
      if (tool !== "mcp__mail__send_email") return { allowed: true };
      const grant = grants.find((candidate) => candidate.tool === tool && exactInput(candidate.input, input));
      if (!grant) {
        audit(pending, "watch.grant_denied", "Watch tool arguments exceeded the approved constraints", false, { tool, input });
        return { allowed: false, reason: "Email not sent: recipient, subject, or body differs from the exact watch authorization." };
      }
      if (!store.claimAction(pending.id, grant.ruleId, tool)) {
        audit(pending, "watch.grant_duplicate_blocked", "Blocked a repeated watch action", false, { tool, ruleId: grant.ruleId });
        return { allowed: false, reason: "Email not sent again: this pre-authorized watch action was already attempted." };
      }
      claimed.set(tool, grant.ruleId);
      audit(pending, "watch.grant_claimed", "Claimed a pre-authorized watch action", true, { tool, ruleId: grant.ruleId, input });
      return { allowed: true };
    },
    async afterExecute(tool, _input, error) {
      const ruleId = claimed.get(tool);
      if (!ruleId) return;
      store.finishAction(pending.id, ruleId, tool, error);
      audit(pending, error ? "watch.action_failed" : "watch.action_completed", error ?? "Pre-authorized watch action completed", !error, { tool, ruleId });
      claimed.delete(tool);
    },
  };
}

function renderTemplate(template: string, pending: PendingWatchEvent): string {
  const state = isRecord(pending.event.currentState) ? pending.event.currentState : {};
  const values: Record<string, unknown> = {
    estimatedArrival: state.estimatedArrival,
    delayMinutes: state.delayMinutes,
    destination: state.destination ?? state.to,
    trainNumber: state.trainNumber,
  };
  return template.replace(/\{\{(estimatedArrival|delayMinutes|destination|trainNumber)\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function exactInput(expected: Record<string, unknown> | undefined, actual: Record<string, unknown>): boolean {
  if (!expected) return false;
  return JSON.stringify(canonical(expected)) === JSON.stringify(canonical(actual));
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
