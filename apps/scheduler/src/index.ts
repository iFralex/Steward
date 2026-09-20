/**
 * Scheduler daemon entrypoint. Started (and kept alive) by the LaunchAgent.
 * Owns every recurring background job; see `jobs.ts` for the registry.
 *
 * Logs go through appendFileSync to a fixed path so they're reliable under
 * launchd (whose stdout redirect can buffer/swallow output), in addition to
 * stdout.
 */
import { appendFileSync } from "node:fs";
import { recordAudit } from "@steward/audit-log";
import { usageLedger } from "@steward/usage-ledger";
import { Scheduler } from "./scheduler.ts";
import { jobs } from "./jobs.ts";

const LOG_FILE = process.env.SCHED_LOG ?? "/tmp/llmwiki-scheduler.jsonl";
const log = (line: string) => {
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* best-effort */ }
  console.log(line);
};

process.on("uncaughtException", (e) => log(`${new Date().toISOString()} [scheduler] UNCAUGHT: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => log(`${new Date().toISOString()} [scheduler] UNHANDLED: ${String(e)}`));

const previousOutcomes = new Map<string, boolean>();
const scheduler = new Scheduler(jobs, {
  runAtStart: true,
  log,
  onResult(result) {
    if (result.skipped) return;
    try {
      usageLedger().recordTool({ ts: Date.now(), sessionId: "scheduler", tool: `scheduler.${result.job}`, durationMs: result.durationMs, ok: result.ok });
    } catch { /* usage tracking is best-effort */ }
    const previous = previousOutcomes.get(result.job);
    previousOutcomes.set(result.job, result.ok);
    if (!result.ok || previous === false) {
      try {
        recordAudit({
          actor: "scheduler", eventType: result.ok ? "scheduler.job_recovered" : "scheduler.job_failed",
          risk: result.ok ? "low" : "medium", summary: result.ok ? `${result.job} recovered` : `${result.job} failed`,
          ok: result.ok, durationMs: result.durationMs, payload: { job: result.job, error: result.error },
        });
      } catch { /* audit tracking is best-effort */ }
    }
  },
});
scheduler.start();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => { scheduler.stop(); process.exit(0); });
}
