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
  timeZone: string;
  context?: TimeContext;
}

interface TimeSnapshot extends TimeResource {
  targetTimeMs: number;
  nowMs: number;
}

export class TimeWatchAdapter implements WatchAdapter {
  readonly source = "time";
  constructor(private readonly now: () => number = Date.now) {}

  async snapshot(resourceRef: string): Promise<TimeSnapshot> {
    const resource = parseTimeResourceRef(resourceRef);
    return { ...resource, targetTimeMs: Date.parse(resource.at), nowMs: this.now() };
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
        ...(context?.eventData ?? {}), scheduledAt: current.at, timeZone: current.timeZone,
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

export function createTimeResourceRef(at: string, timeZone: string, context?: TimeContext): string {
  validateTimeResource({ at, timeZone, ...(context ? { context } : {}) });
  return JSON.stringify({ at, timeZone, ...(context ? { context } : {}) });
}

export function parseTimeResourceRef(value: string): TimeResource {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("A time resourceRef must be generated from at and timeZone"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid time resourceRef");
  const row = parsed as Record<string, unknown>;
  const resource = { at: row.at, timeZone: row.timeZone, ...(row.context ? { context: row.context } : {}) } as TimeResource;
  validateTimeResource(resource);
  return resource;
}

function validateTimeResource(resource: TimeResource): void {
  if (typeof resource.at !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(resource.at)) {
    throw new Error("at must be an ISO 8601 date-time with an explicit UTC offset");
  }
  const target = Date.parse(resource.at);
  if (!Number.isFinite(target)) throw new Error("at must be a valid ISO 8601 date-time");
  if (typeof resource.timeZone !== "string" || !resource.timeZone.trim()) throw new Error("timeZone is required");
  let actualOffset: number;
  try { actualOffset = zoneOffsetMinutes(target, resource.timeZone); }
  catch { throw new Error(`Invalid IANA time zone: ${resource.timeZone}`); }
  const declaredOffset = isoOffsetMinutes(resource.at);
  if (declaredOffset !== actualOffset) {
    throw new Error(`The UTC offset in at does not match ${resource.timeZone} at that date`);
  }
}

function isoOffsetMinutes(value: string): number {
  if (/Z$/i.test(value)) return 0;
  const match = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Missing UTC offset");
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function zoneOffsetMinutes(timestamp: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second));
  return Math.round((representedAsUtc - Math.trunc(timestamp / 1_000) * 1_000) / 60_000);
}

function timeSnapshot(value: unknown): TimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid time snapshot");
  const row = value as Partial<TimeSnapshot>;
  if (typeof row.targetTimeMs !== "number" || typeof row.nowMs !== "number" || typeof row.at !== "string" || typeof row.timeZone !== "string") {
    throw new Error("Invalid time snapshot");
  }
  return row as TimeSnapshot;
}
