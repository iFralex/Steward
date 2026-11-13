import { Worker } from "node:worker_threads";
import type { LedgerSummary } from "@steward/usage-ledger";

// A single worker limits memory and overlapping historical scans. Coalesce
// concurrent requests and cache completed summaries briefly for page refreshes.
const cache = new Map<string, { ts: number; value: LedgerSummary }>();
const pending = new Map<string, Promise<LedgerSummary>>();
let queue: Promise<unknown> = Promise.resolve();
export function usageSummary(days?: number): Promise<LedgerSummary> {
  const key = String(days ?? "all");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 30_000) return Promise.resolve(hit.value);
  const existing = pending.get(key);
  if (existing) return existing;
  const task = queue.catch(() => {}).then(() => new Promise<LedgerSummary>((resolve, reject) => {
    const path = process.env.STEWARD_USAGE_SUMMARY_WORKER;
    const worker = new Worker(path ?? new URL(import.meta.url.endsWith(".js")
      ? "../workers/usage-summary-worker.js" : "./usage-summary-worker.ts", import.meta.url));
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Usage summary timed out")); }, 180_000);
    let settled = false;
    worker.once("message", ({ summary, error }) => {
      settled = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(new Error(error)); else resolve(summary);
    });
    worker.once("error", error => { settled = true; clearTimeout(timer); reject(error); });
    worker.once("exit", code => { if (!settled) { clearTimeout(timer); reject(new Error(`Usage worker exited (${code})`)); } });
    worker.postMessage({ days });
  })).then(value => {
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(key, { ts: Date.now(), value }); return value;
  }).finally(() => pending.delete(key));
  pending.set(key, task); queue = task;
  return task;
}
