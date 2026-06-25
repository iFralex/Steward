/**
 * Scheduler daemon entrypoint. Started (and kept alive) by the LaunchAgent.
 * Owns every recurring background job; see `jobs.ts` for the registry.
 */
import { Scheduler } from "./scheduler.ts";
import { jobs } from "./jobs.ts";

const scheduler = new Scheduler(jobs, { runAtStart: true });
scheduler.start();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => { scheduler.stop(); process.exit(0); });
}
