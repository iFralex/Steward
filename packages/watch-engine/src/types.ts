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
}

export interface PendingWatchEvent {
  id: string;
  watchId: string;
  chatId: string;
  instruction: string;
  rule: WatchRule;
  event: DomainEvent;
  attempts: number;
}

export interface WatchAdapter {
  source: string;
  snapshot(resourceRef: string): Promise<unknown>;
  events(previous: unknown, current: unknown): DomainEvent[];
  defaultExpiry(snapshot: unknown): number;
  isTerminal(snapshot: unknown): boolean;
}
