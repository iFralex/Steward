import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WatchEngine, WatchStore, type DomainEvent, type WatchAdapter } from "../src/index.ts";

interface Snapshot { step: number; terminal?: boolean }

class FakeAdapter implements WatchAdapter {
  readonly source = "fake";
  current: Snapshot = { step: 0 };
  snapshot(): Promise<Snapshot> { return Promise.resolve(this.current); }
  defaultExpiry(): number { return Date.now() + 60_000; }
  isTerminal(value: unknown): boolean { return (value as Snapshot).terminal === true; }
  events(previousValue: unknown, currentValue: unknown): DomainEvent[] {
    const previous = previousValue as Snapshot;
    const current = currentValue as Snapshot;
    if (previous.step === current.step) return [];
    return [{
      key: `step:${current.step}`,
      type: "fake.changed",
      timestamp: Date.now(),
      data: { step: current.step, position: current.step - 2 },
      previousState: previous,
      currentState: current,
      fallbackText: `Step ${current.step}`,
    }];
  }
}

function fixture(): { engine: WatchEngine; store: WatchStore; adapter: FakeAdapter; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "steward-watch-"));
  const store = WatchStore.open(join(dir, "watches.db"));
  const adapter = new FakeAdapter();
  return {
    store,
    adapter,
    engine: new WatchEngine(store).register(adapter),
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("poll translates a state change into a durable matching event", async () => {
  const fx = fixture();
  try {
    const watch = await fx.engine.create({
      source: "fake", resourceRef: "resource-1", chatId: "chat-1", instruction: "Avvisami",
      rules: [{ id: "before", event: "fake.changed", where: { position: -1 }, once: true }],
    });
    fx.adapter.current = { step: 1 };

    assert.equal(await fx.engine.poll(), 1);
    const [pending] = fx.store.pending();
    assert.equal(pending.watchId, watch.id);
    assert.equal(pending.event.type, "fake.changed");
    assert.deepEqual(pending.rule.where, { position: -1 });

    assert.equal(await fx.engine.poll(), 0, "the same state must not enqueue twice");
    fx.adapter.current = { step: 2 };
    assert.equal(await fx.engine.poll(), 0, "a once rule must not fire a second time");
  } finally { fx.cleanup(); }
});

test("stopped and terminal watches are no longer polled", async () => {
  const fx = fixture();
  try {
    const stopped = await fx.engine.create({
      source: "fake", resourceRef: "stopped", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    });
    assert.equal(fx.engine.stop(stopped.id).status, "stopped");
    fx.adapter.current = { step: 1 };
    assert.equal(await fx.engine.poll(), 0);

    const terminal = await fx.engine.create({
      source: "fake", resourceRef: "terminal", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    });
    fx.adapter.current = { step: 2, terminal: true };
    assert.equal(await fx.engine.poll(), 1);
    assert.equal(fx.store.get(terminal.id)?.status, "completed");
  } finally { fx.cleanup(); }
});
