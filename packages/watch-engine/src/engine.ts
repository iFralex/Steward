import { matchesRule } from "./match.ts";
import { WatchStore } from "./store.ts";
import type { WatchAdapter, WatchDefinition, WatchEngineObserver, WatchRecord } from "./types.ts";

export class WatchEngine {
  private readonly adapters = new Map<string, WatchAdapter>();
  constructor(readonly store: WatchStore, private readonly observer: WatchEngineObserver = {}) {}

  private notify<K extends keyof WatchEngineObserver>(name: K, ...args: Parameters<NonNullable<WatchEngineObserver[K]>>): void {
    try { (this.observer[name] as ((...values: typeof args) => void) | undefined)?.(...args); } catch { /* observers are best-effort */ }
  }

  register(adapter: WatchAdapter): this {
    this.adapters.set(adapter.source, adapter);
    return this;
  }

  sources(): string[] { return [...this.adapters.keys()]; }

  async create(definition: WatchDefinition): Promise<WatchRecord> {
    if (!definition.rules.length) throw new Error("At least one watch rule is required.");
    const ids = new Set<string>();
    for (const rule of definition.rules) {
      if (!rule.id || !rule.event) throw new Error("Every watch rule requires id and event.");
      if (ids.has(rule.id)) throw new Error(`Duplicate watch rule id: ${rule.id}`);
      ids.add(rule.id);
    }
    const adapter = this.adapters.get(definition.source);
    if (!adapter) throw new Error(`Unsupported watch source: ${definition.source}. Available: ${this.sources().join(", ")}`);
    const snapshot = await adapter.snapshot(definition.resourceRef);
    const watch = this.store.create(definition, snapshot, adapter.defaultExpiry(snapshot));
    this.notify("watchCreated", watch);
    return watch;
  }

  stop(id: string): WatchRecord {
    const before = this.store.get(id);
    const watch = this.store.stop(id);
    if (!watch) throw new Error(`Watch ${id} was not found.`);
    if (before?.status === "active" && watch.status === "stopped") this.notify("watchStopped", watch);
    return watch;
  }

  async poll(): Promise<number> {
    let queued = 0;
    for (const watch of this.store.expireDue()) this.notify("watchExpired", watch);
    for (const watch of this.store.active()) {
      const startedAt = Date.now();
      const adapter = this.adapters.get(watch.source);
      if (!adapter) {
        const message = `No adapter registered for ${watch.source}`;
        this.store.updateError(watch.id, message);
        this.notify("pollFailed", watch, message, Date.now() - startedAt);
        continue;
      }
      try {
        const current = await adapter.snapshot(watch.resourceRef);
        let watchQueued = 0;
        for (const event of adapter.events(watch.snapshot, current)) {
          for (const rule of watch.rules) {
            if (!matchesRule(rule, event)) continue;
            if (rule.once && this.store.hasRuleFired(watch.id, rule.id)) continue;
            if (this.store.enqueue(watch, rule, event)) {
              queued++;
              watchQueued++;
              this.notify("eventQueued", watch, rule, event);
            }
          }
        }
        const terminal = adapter.isTerminal(current);
        this.store.updateSnapshot(watch.id, current, terminal);
        const updated = this.store.get(watch.id) ?? { ...watch, snapshot: current };
        this.notify("pollCompleted", updated, { durationMs: Date.now() - startedAt, queued: watchQueued, terminal });
        if (terminal) this.notify("watchCompleted", updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateError(watch.id, message);
        this.notify("pollFailed", watch, message, Date.now() - startedAt);
      }
    }
    return queued;
  }
}

export * from "./types.ts";
export * from "./store.ts";
export * from "./match.ts";
