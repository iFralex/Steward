import assert from "node:assert/strict";
import { test } from "node:test";
import { TrainWatchAdapter } from "../src/core/train-watch-adapter.ts";
import type { TrainSnapshot } from "../../train-mcp/src/types.ts";

function snapshot(overrides: Partial<TrainSnapshot> = {}): TrainSnapshot {
  return {
    trainRef: "eyJ2ZXJzaW9uIjoxfQ", trainNumber: "1234", from: "Milano Centrale", to: "Monza",
    delayMinutes: 0, platformStatus: "unknown", cancelled: false, departed: false, arrived: false,
    stops: [
      { id: "S1", name: "Milano Centrale", index: 0, cancelled: false, positionRelativeToDestination: -2 },
      { id: "S2", name: "Sesto San Giovanni", index: 1, cancelled: false, positionRelativeToDestination: -1 },
      { id: "S3", name: "Monza", index: 2, cancelled: false, positionRelativeToDestination: 0 },
    ],
    lastUpdated: "2026-09-18T08:00:00.000Z", source: "ViaggiaTreno", ...overrides,
  };
}

const unusedService = { status: async () => snapshot() };

test("emits platform confidence, departure and delay changes", () => {
  const adapter = new TrainWatchAdapter(unusedService);
  const events = adapter.events(snapshot(), snapshot({
    platform: "7", scheduledPlatform: "7", actualPlatform: "7", platformStatus: "confirmed",
    departed: true, delayMinutes: 8,
  }));
  assert.deepEqual(events.map((event) => event.type), [
    "train.platform_announced", "train.platform_confirmed", "train.departed", "train.delay_changed",
  ]);
  assert.match(events[0].fallbackText, /confermato/);
  assert.equal(events[0].data.platformStatus, "confirmed");
  assert.equal(events[0].notification?.title?.it, "Aggiornamento treno");
  const guidance = events[0].notification?.guidance;
  assert.match(typeof guidance === "object" ? guidance.en : "", /scheduled-only/);
});

test("emits the preceding-stop and destination milestones with relative positions", () => {
  const adapter = new TrainWatchAdapter(unusedService);
  const current = snapshot();
  current.stops[1] = { ...current.stops[1], actualArrivalMs: 10, actualArrival: "10:10" };
  current.stops[2] = { ...current.stops[2], actualArrivalMs: 20, actualArrival: "10:20" };
  const events = adapter.events(snapshot(), current).filter((event) => event.type === "train.stop_arrived");

  assert.deepEqual(events.map((event) => event.data.positionRelativeToDestination), [-1, 0]);
  assert.match(events[0].fallbackText, /Prossima fermata: Monza/);
  assert.match(events[1].fallbackText, /devi scendere/);
});

test("scheduled-only platform is never called confirmed", () => {
  const adapter = new TrainWatchAdapter(unusedService);
  const [event] = adapter.events(snapshot(), snapshot({
    platform: "4", scheduledPlatform: "4", platformStatus: "scheduled",
  }));
  assert.equal(event.type, "train.platform_announced");
  assert.match(event.fallbackText, /non ancora confermato/);
});
