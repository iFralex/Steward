/**
 * A tiny periodic-job scheduler: the single daemon that runs all of this
 * software's recurring background work (mail reconcile/embed/distill today,
 * more later). Each job declares its own interval; the scheduler guarantees:
 *   - no-overlap: a job is never re-entered while its previous run is in flight;
 *   - error isolation: a failing job is logged but never stops the others;
 *   - structured logging: every run logs start outcome + duration.
 */
export interface Job {
  name: string;
  /** Run interval in milliseconds. */
  everyMs: number;
  run: () => Promise<void>;
}

export interface SchedulerOptions {
  /** Where log lines go (default console.log). */
  log?: (line: string) => void;
  /** Run every job once immediately on start (default true). */
  runAtStart?: boolean;
}

export class Scheduler {
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly running = new Set<string>();
  private readonly log: (line: string) => void;

  constructor(private readonly jobs: Job[], private readonly opts: SchedulerOptions = {}) {
    this.log = opts.log ?? ((l) => console.log(l));
  }

  start(): void {
    for (const job of this.jobs) {
      if (this.opts.runAtStart !== false) void this.tick(job);
      this.timers.push(setInterval(() => void this.tick(job), job.everyMs));
    }
    this.log(`${this.ts()} [scheduler] started ${this.jobs.length} job(s): ${this.jobs.map((j) => `${j.name}@${Math.round(j.everyMs / 60000)}min`).join(", ")}`);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  /** Run one job now, respecting no-overlap + error isolation. Exposed for tests. */
  async tick(job: Job): Promise<void> {
    if (this.running.has(job.name)) {
      this.log(`${this.ts()} [${job.name}] skip — previous run still in progress`);
      return;
    }
    this.running.add(job.name);
    const t0 = Date.now();
    try {
      await job.run();
      this.log(`${this.ts()} [${job.name}] ok (${Date.now() - t0}ms)`);
    } catch (err) {
      this.log(`${this.ts()} [${job.name}] FAILED (${Date.now() - t0}ms): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running.delete(job.name);
    }
  }

  private ts(): string {
    return new Date().toISOString();
  }
}
