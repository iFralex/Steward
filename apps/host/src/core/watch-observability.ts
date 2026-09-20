import { recordAudit, type AuditEventInput } from "@steward/audit-log";
import { usageLedger } from "@steward/usage-ledger";
import type { DomainEvent, WatchEngineObserver, WatchRecord, WatchRule } from "@steward/watch-engine";

function watchPayload(watch: WatchRecord): Record<string, unknown> {
  return {
    watchId: watch.id,
    source: watch.source,
    resourceRef: watch.resourceRef,
    status: watch.status,
    ruleIds: watch.rules.map((rule) => rule.id),
    grants: watch.rules.flatMap((rule) => (rule.grants ?? []).map((grant) => ({ ruleId: rule.id, ...grant }))),
    expiresAt: watch.expiresAt,
  };
}

function audit(watch: WatchRecord, input: Omit<AuditEventInput, "chatId" | "correlationId">): void {
  recordAudit({ ...input, chatId: watch.chatId, correlationId: watch.id });
}

/** Maps generic watch lifecycle hooks to Steward's existing ledgers. */
export function createWatchObserver(): WatchEngineObserver {
  return {
    watchCreated(watch) {
      audit(watch, {
        actor: "host", eventType: "watch.created", risk: "low", summary: `Created ${watch.source} watch`, ok: true,
        payload: watchPayload(watch), sourceRefs: [{ type: "watch", id: watch.id, label: watch.source }],
      });
    },
    watchStopped(watch) {
      audit(watch, {
        actor: "host", eventType: "watch.stopped", risk: "low", summary: `Stopped ${watch.source} watch`, ok: true,
        payload: watchPayload(watch), sourceRefs: [{ type: "watch", id: watch.id, label: watch.source }],
      });
    },
    watchExpired(watch) {
      audit(watch, {
        actor: "scheduler", eventType: "watch.expired", risk: "low", summary: `${watch.source} watch expired`, ok: true,
        payload: watchPayload(watch), sourceRefs: [{ type: "watch", id: watch.id, label: watch.source }],
      });
    },
    eventQueued(watch: WatchRecord, rules: WatchRule[], event: DomainEvent) {
      audit(watch, {
        actor: "scheduler", eventType: "watch.event_queued", risk: "low", summary: `Queued ${event.type}`,
        ok: true, payload: { ...watchPayload(watch), rules, event },
        sourceRefs: [{ type: "watch", id: watch.id, label: event.type }],
      });
    },
    pollCompleted(watch, result) {
      try {
        usageLedger().recordTool({
          ts: Date.now(), sessionId: `watch:${watch.id}`, tool: `watch.poll.${watch.source}`,
          durationMs: result.durationMs, ok: true,
        });
      } catch { /* usage is best-effort */ }
    },
    pollFailed(watch, error, durationMs) {
      try {
        usageLedger().recordTool({
          ts: Date.now(), sessionId: `watch:${watch.id}`, tool: `watch.poll.${watch.source}`,
          durationMs, ok: false,
        });
      } catch { /* usage is best-effort */ }
      audit(watch, {
        actor: "scheduler", eventType: "watch.poll_failed", risk: "medium", summary: `${watch.source} watch poll failed`,
        ok: false, durationMs, payload: { ...watchPayload(watch), error },
        sourceRefs: [{ type: "watch", id: watch.id, label: watch.source }],
      });
    },
    watchCompleted(watch) {
      audit(watch, {
        actor: "scheduler", eventType: "watch.completed", risk: "low", summary: `${watch.source} watch completed`, ok: true,
        payload: watchPayload(watch), sourceRefs: [{ type: "watch", id: watch.id, label: watch.source }],
      });
    },
  };
}

export function recordWatchDeliveryUsage(watchId: string, durationMs: number, ok: boolean): void {
  try {
    usageLedger().recordTool({ ts: Date.now(), sessionId: `watch:${watchId}`, tool: "watch.deliver", durationMs, ok });
  } catch { /* usage is best-effort */ }
}
