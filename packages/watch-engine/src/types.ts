export interface WatchRule {
  id: string;
  event: string;
  where?: Record<string, unknown>;
  once?: boolean;
}

export interface WatchDefinition {
  source: string;
  resourceRef: string;
  rules: WatchRule[];
  instruction: string;
  chatId: string;
  expiresAt?: number;
}

export interface WatchRecord extends WatchDefinition {
  id: string;
  status: "active" | "stopped" | "completed" | "expired";
  snapshot: unknown;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt?: number;
  lastError?: string;
}

export interface DomainEvent {
  /** Stable within a resource; used to avoid duplicate delivery after restarts. */
  key: string;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
  previousState?: unknown;
  currentState: unknown;
  fallbackText: string;
  /** Optional presentation hints owned by the source adapter. The generic
   * engine stores and forwards them without interpreting the domain. */
  notification?: {
    title?: Record<string, string>;
    guidance?: string | Record<string, string>;
  };
}

export interface PendingWatchEvent {
  id: string;
  watchId: string;
  chatId: string;
  instruction: string;
  rule: WatchRule;
  event: DomainEvent;
  attempts: number;
  notificationText?: string;
}

export interface WatchAdapter {
  source: string;
  snapshot(resourceRef: string): Promise<unknown>;
  events(previous: unknown, current: unknown): DomainEvent[];
  defaultExpiry(snapshot: unknown): number;
  isTerminal(snapshot: unknown): boolean;
}

/** Optional lifecycle hooks. The engine stays storage/domain-only; hosts can
 * attach audit, metrics or tracing without coupling those concerns here. */
export interface WatchEngineObserver {
  watchCreated?(watch: WatchRecord): void;
  watchStopped?(watch: WatchRecord): void;
  watchExpired?(watch: WatchRecord): void;
  eventQueued?(watch: WatchRecord, rule: WatchRule, event: DomainEvent): void;
  pollCompleted?(watch: WatchRecord, result: { durationMs: number; queued: number; terminal: boolean }): void;
  pollFailed?(watch: WatchRecord, error: string, durationMs: number): void;
  watchCompleted?(watch: WatchRecord): void;
}
