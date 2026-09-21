import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WatchEngine, WatchStore } from "@steward/watch-engine";
import { TrainWatchAdapter } from "./train-watch-adapter.ts";
import { TimeWatchAdapter } from "./time-watch-adapter.ts";
import { createWatchObserver } from "./watch-observability.ts";

let shared: WatchEngine | null = null;

export function watchDbPath(): string {
  const path = process.env.WATCH_DB ?? join(homedir(), "Library", "Application Support", "Steward", "watches.db");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}

export function sharedWatchEngine(): WatchEngine {
  if (!shared) shared = new WatchEngine(WatchStore.open(watchDbPath()), createWatchObserver())
    .register(new TrainWatchAdapter())
    .register(new TimeWatchAdapter());
  return shared;
}

export function resetSharedWatchEngineForTests(): void {
  shared?.store.close();
  shared = null;
}
