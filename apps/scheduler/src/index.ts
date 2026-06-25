/**
 * Scheduler daemon entrypoint. Started (and kept alive) by the LaunchAgent.
 * Owns every recurring background job; see `jobs.ts` for the registry.
 *
 * Logs go through appendFileSync to a fixed path so they're reliable under
 * launchd (whose stdout redirect can buffer/swallow output), in addition to
 * stdout.
 */
import { appendFileSync } from "node:fs";
import { Scheduler } from "./scheduler.ts";
import { jobs } from "./jobs.ts";

const LOG_FILE = process.env.SCHED_LOG ?? "/tmp/llmwiki-scheduler.jsonl";
const log = (line: string) => {
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* best-effort */ }
  console.log(line);
};

process.on("uncaughtException", (e) => log(`${new Date().toISOString()} [scheduler] UNCAUGHT: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => log(`${new Date().toISOString()} [scheduler] UNHANDLED: ${String(e)}`));

const scheduler = new Scheduler(jobs, { runAtStart: true, log });
scheduler.start();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => { scheduler.stop(); process.exit(0); });
}
