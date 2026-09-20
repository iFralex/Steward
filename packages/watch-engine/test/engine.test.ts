import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WatchEngine, WatchStore, type DomainEvent, type WatchAdapter, type WatchEngineObserver } from "../src/index.ts";

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

function fixture(observer?: WatchEngineObserver): { engine: WatchEngine; store: WatchStore; adapter: FakeAdapter; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "steward-watch-"));
  const store = WatchStore.open(join(dir, "watches.db"));
  const adapter = new FakeAdapter();
  return {
    store,
    adapter,
    engine: new WatchEngine(store, observer).register(adapter),
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("poll translates a state change into a durable matching event", async () => {
  const fx = fixture();
  try {
    const watch = await fx.engine.create({
      source: "fake", resourceRef: "resource-1", chatId: "chat-1", instruction: "Avvisami",
      rules: [{ id: "before", event: "fake.changed", where: { position: -1 }, once: true }],
      authorizedTools: ["mcp__voice__call_start"],
    });
    fx.adapter.current = { step: 1 };

    assert.equal(await fx.engine.poll(), 1);
    const [pending] = fx.store.pending();
    assert.equal(pending.watchId, watch.id);
    assert.equal(pending.event.type, "fake.changed");
    assert.deepEqual(pending.rule.where, { position: -1 });
    assert.equal(pending.resourceRef, "resource-1");
    assert.deepEqual(pending.authorizedTools, ["mcp__voice__call_start"]);
    assert.deepEqual(fx.store.get(watch.id)?.authorizedTools, ["mcp__voice__call_start"]);
    fx.store.setNotificationText(pending.id, "Already composed");
    assert.equal(fx.store.pending()[0].notificationText, "Already composed", "composed text must survive a push retry");

    assert.equal(await fx.engine.poll(), 0, "the same state must not enqueue twice");
    fx.adapter.current = { step: 2 };
    assert.equal(await fx.engine.poll(), 0, "a once rule must not fire a second time");
  } finally { fx.cleanup(); }
});

test("lifecycle observer receives durable transitions and remains best-effort", async () => {
  const seen: string[] = [];
  const fx = fixture({
    watchCreated: () => seen.push("created"),
    eventQueued: () => seen.push("queued"),
    pollCompleted: (_watch, result) => seen.push(`polled:${result.queued}`),
    watchCompleted: () => seen.push("completed"),
  });
  try {
    await fx.engine.create({
      source: "fake", resourceRef: "observed", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    });
    fx.adapter.current = { step: 1, terminal: true };
    await fx.engine.poll();
    assert.deepEqual(seen, ["created", "queued", "polled:1", "completed"]);
  } finally { fx.cleanup(); }

  const throwing = fixture({ pollCompleted: () => { throw new Error("observer failed"); } });
  try {
    await throwing.engine.create({
      source: "fake", resourceRef: "safe", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    });
    await assert.doesNotReject(() => throwing.engine.poll());
  } finally { throwing.cleanup(); }
});

test("expired watches are surfaced without being polled", async () => {
  const expired: string[] = [];
  const fx = fixture({ watchExpired: (watch) => expired.push(watch.id) });
  try {
    const watch = await fx.engine.create({
      source: "fake", resourceRef: "expired", chatId: "chat", instruction: "x", expiresAt: Date.now() - 1,
      rules: [{ id: "change", event: "fake.changed" }],
    });
    assert.equal(await fx.engine.poll(), 0);
    assert.deepEqual(expired, [watch.id]);
    assert.equal(fx.store.get(watch.id)?.status, "expired");
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
