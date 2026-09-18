import { matchesRule } from "./match.ts";
import { WatchStore } from "./store.ts";
import type { WatchAdapter, WatchDefinition, WatchRecord } from "./types.ts";

export class WatchEngine {
  private readonly adapters = new Map<string, WatchAdapter>();
  constructor(readonly store: WatchStore) {}

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
    return this.store.create(definition, snapshot, adapter.defaultExpiry(snapshot));
  }

  stop(id: string): WatchRecord {
    const watch = this.store.stop(id);
    if (!watch) throw new Error(`Watch ${id} was not found.`);
    return watch;
  }

  async poll(): Promise<number> {
    let queued = 0;
    for (const watch of this.store.active()) {
      const adapter = this.adapters.get(watch.source);
      if (!adapter) { this.store.updateError(watch.id, `No adapter registered for ${watch.source}`); continue; }
      try {
        const current = await adapter.snapshot(watch.resourceRef);
        for (const event of adapter.events(watch.snapshot, current)) {
          for (const rule of watch.rules) {
            if (!matchesRule(rule, event)) continue;
            if (rule.once && this.store.hasRuleFired(watch.id, rule.id)) continue;
            if (this.store.enqueue(watch, rule, event)) queued++;
          }
        }
        this.store.updateSnapshot(watch.id, current, adapter.isTerminal(current));
      } catch (error) {
        this.store.updateError(watch.id, error instanceof Error ? error.message : String(error));
      }
    }
    return queued;
  }
}

export * from "./types.ts";
export * from "./store.ts";
export * from "./match.ts";
