import type { DomainEvent, WatchAdapter, WatchDefinition, WatchRecord } from "@steward/watch-engine";

interface TimeContext {
  eventData?: Record<string, unknown>;
  currentState?: unknown;
  fallbackText?: string;
  notification?: DomainEvent["notification"];
  originResourceRef?: string;
  originEventType?: string;
  outcome?: string;
  attempt?: number;
}

interface TimeResource {
  at: string;
  context?: TimeContext;
}

interface TimeSnapshot extends TimeResource {
  timeZone: string;
  targetTimeMs: number;
  nowMs: number;
}

export class TimeWatchAdapter implements WatchAdapter {
  readonly source = "time";
  constructor(private readonly now: () => number = Date.now) {}

  async snapshot(resourceRef: string): Promise<TimeSnapshot> {
    const resource = parseTimeResourceRef(resourceRef);
    return {
      ...resource,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      targetTimeMs: Date.parse(resource.at), nowMs: this.now(),
    };
  }

  defaultExpiry(value: unknown): number {
    return timeSnapshot(value).targetTimeMs + 60 * 60_000;
  }

  isTerminal(value: unknown): boolean {
    const snapshot = timeSnapshot(value);
    return snapshot.nowMs >= snapshot.targetTimeMs;
  }

  validate(definition: WatchDefinition, value: unknown): void {
    const snapshot = timeSnapshot(value);
    if (snapshot.targetTimeMs <= this.now()) throw new Error("A time watch must target a future instant");
    if (definition.expiresAt !== undefined && definition.expiresAt <= snapshot.targetTimeMs) {
      throw new Error("A time watch must expire after its target instant");
    }
    for (const rule of definition.rules) {
      if (rule.event !== "time.reached" || rule.trigger) {
        throw new Error("Time watches support only event='time.reached'");
      }
    }
  }

  pollIntervalMs(watch: WatchRecord, now: number): number {
    const remaining = timeSnapshot(watch.snapshot).targetTimeMs - now;
    if (remaining <= 10 * 60_000) return 5_000;
    if (remaining <= 30 * 60_000) return 15_000;
    return 45_000;
  }

  events(previousValue: unknown, currentValue: unknown): DomainEvent[] {
    const previous = timeSnapshot(previousValue);
    const current = timeSnapshot(currentValue);
    if (previous.nowMs >= current.targetTimeMs || current.nowMs < current.targetTimeMs) return [];
    const context = current.context;
    return [{
      key: `reached:${current.targetTimeMs}`,
      type: "time.reached",
      timestamp: current.nowMs,
      data: {
        ...(context?.eventData ?? {}), scheduledAt: toLocalRfc3339(current.at), timeZone: current.timeZone,
        ...(context?.originResourceRef ? { originResourceRef: context.originResourceRef } : {}),
        ...(context?.originEventType ? { originEventType: context.originEventType } : {}),
        ...(context?.outcome ? { previousOutcome: context.outcome } : {}),
        ...(context?.attempt ? { attempt: context.attempt } : {}),
      },
      currentState: context?.currentState ?? current,
      fallbackText: context?.fallbackText ?? `Scheduled time reached: ${current.at}`,
      ...(context?.notification ? { notification: context.notification } : {}),
    }];
  }
}

export function createTimeResourceRef(at: string, context?: TimeContext): string {
  const normalizedAt = normalizeInstant(at);
  return JSON.stringify({ at: normalizedAt, ...(context ? { context } : {}) });
}

export function parseTimeResourceRef(value: string): TimeResource {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("A time resourceRef must be generated from at"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid time resourceRef");
  const row = parsed as Record<string, unknown>;
  const resource = { at: normalizeInstant(row.at), ...(row.context ? { context: row.context } : {}) } as TimeResource;
  return resource;
}

function normalizeInstant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error("at must be an ISO 8601 date-time with an explicit UTC offset");
  }
  const target = Date.parse(value);
  if (!Number.isFinite(target)) throw new Error("at must be a valid ISO 8601 date-time");
  return new Date(target).toISOString();
}

function toLocalRfc3339(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  const eastOfUtcMinutes = -date.getTimezoneOffset();
  const sign = eastOfUtcMinutes >= 0 ? "+" : "-";
  const offset = Math.abs(eastOfUtcMinutes);
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`,
  ].join("");
}

function timeSnapshot(value: unknown): TimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid time snapshot");
  const row = value as Partial<TimeSnapshot>;
  if (typeof row.targetTimeMs !== "number" || typeof row.nowMs !== "number" || typeof row.at !== "string" || typeof row.timeZone !== "string") {
    throw new Error("Invalid time snapshot");
  }
  return row as TimeSnapshot;
}
