import assert from "node:assert/strict";
import { test } from "node:test";
import { Scheduler, type Job } from "../src/scheduler.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("runs each job once immediately when runAtStart", async () => {
  let ran = 0;
  const s = new Scheduler([{ name: "x", everyMs: 100_000, run: async () => { ran++; } }], { runAtStart: true, log: () => {} });
  s.start(); await delay(10); s.stop();
  assert.equal(ran, 1);
});

test("no-overlap: a slow job is never re-entered while its run is in flight", async () => {
  let active = 0, maxActive = 0;
  const job: Job = { name: "slow", everyMs: 5, run: async () => { active++; maxActive = Math.max(maxActive, active); await delay(40); active--; } };
  const s = new Scheduler([job], { runAtStart: true, log: () => {} });
  s.start(); await delay(60); s.stop();
  assert.equal(maxActive, 1, "must never run two instances of the same job at once");
});

test("error isolation: a failing job is logged and others keep running", async () => {
  const logs: string[] = [];
  let bRuns = 0;
  const a: Job = { name: "a", everyMs: 5, run: async () => { throw new Error("boom"); } };
  const b: Job = { name: "b", everyMs: 5, run: async () => { bRuns++; } };
  const s = new Scheduler([a, b], { runAtStart: true, log: (l) => logs.push(l) });
  s.start(); await delay(30); s.stop();
  assert.ok(logs.some((l) => /\[a\] FAILED.*boom/.test(l)), "the failing job is logged");
  assert.ok(bRuns > 0, "the other job keeps running");
});

test("tick logs ok with a duration", async () => {
  const logs: string[] = [];
  const s = new Scheduler([], { log: (l) => logs.push(l) });
  await s.tick({ name: "j", everyMs: 1000, run: async () => { await delay(5); } });
  assert.ok(logs.some((l) => /\[j\] ok \(\d+ms\)/.test(l)));
});
