/**
 * The registry of periodic jobs. Add a service = add one entry here.
 * Each job shells out to an existing CLI (via `node --import tsx <cli> …`),
 * so the scheduler stays a thin orchestrator with no business logic.
 * Intervals are overridable via env for tuning without code changes.
 */
import { fileURLToPath } from "node:url";
import { exec } from "./exec.ts";
import type { Job } from "./scheduler.ts";

const NODE = process.execPath;
const cli = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const mins = (env: string, def: number) => Math.max(1, Number(process.env[env] ?? def)) * 60_000;
// Run the CLIs from the repo root so `--import tsx` resolves (under launchd the
// daemon's cwd is `/`, where tsx isn't on the module path).
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Run an existing CLI command as a job. */
const runCli = (entry: string, args: string[], timeoutMs: number) => () =>
  exec(NODE, ["--import", "tsx", entry, ...args], { timeoutMs, cwd: REPO_ROOT });

const MAIL_MIRROR = cli("../../mail-mirror/src/cli.ts");
const MAIL_PROMOTER = cli("../../mail-promoter/src/cli.ts");
const ACTION_CENTER = cli("../../action-center/src/cli.ts");
const WRITE_OPS = cli("../../../packages/write-ops/src/cli.ts");
const CALENDAR_MCP = cli("../../calendar-mcp/src/cli.ts");

export const jobs: Job[] = [
  // 1) Ingest new/changed mail from Apple Mail into the local mirror.
  { name: "mail-reconcile", everyMs: mins("SCHED_RECONCILE_MIN", 10), run: runCli(MAIL_MIRROR, ["reconcile"], 5 * 60_000) },
  // 1b) Confirm/retry AppleScript writes using the reconciled mail mirror.
  { name: "write-ops-mail", everyMs: mins("SCHED_RECONCILE_MIN", 10), run: runCli(WRITE_OPS, ["reconcile-mail"], 10 * 60_000) },
  // 2) Embed not-yet-embedded mail so they're semantically searchable.
  { name: "mail-embed", everyMs: mins("SCHED_EMBED_MIN", 15), run: runCli(MAIL_MIRROR, ["embed"], 20 * 60_000) },
  // 3) Triage + distil new mail into wiki source notes (writes to disk; gateway-backed).
  { name: "mail-distill", everyMs: mins("SCHED_DISTILL_MIN", 15), run: runCli(MAIL_PROMOTER, ["backfill"], 30 * 60_000) },
  // 4) Build the user's actionable notification center: reply-needed mail + upcoming events.
  { name: "calendar-sync", everyMs: mins("SCHED_CALENDAR_SYNC_MIN", 10), run: runCli(CALENDAR_MCP, ["sync"], 5 * 60_000) },
  { name: "write-ops-calendar", everyMs: mins("SCHED_CALENDAR_SYNC_MIN", 10), run: runCli(WRITE_OPS, ["reconcile-calendar"], 5 * 60_000) },
  { name: "action-center", everyMs: mins("SCHED_ACTION_CENTER_MIN", 10), run: runCli(ACTION_CENTER, ["scan"], 10 * 60_000) },
];
