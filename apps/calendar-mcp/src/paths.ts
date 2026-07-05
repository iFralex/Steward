import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

export function applePath(): string {
  return join(homedir(), "Library", "Group Containers", "group.com.apple.calendar", "Calendar.sqlitedb");
}

export function indexDbPath(): string {
  if (process.env.CALENDAR_INDEX_DB) return process.env.CALENDAR_INDEX_DB;
  const support = join(homedir(), "Library", "Application Support");
  const current = join(support, "steward", "calendar-index.sqlitedb");
  migrateLegacyIndex(join(support, "llm-wiki", "calendar-index.sqlitedb"), current);
  return current;
}

/** One-time, non-destructive migration after the LLM Wiki → Steward rename. The
 *  index is rebuildable from Calendar, so this is best-effort. */
function migrateLegacyIndex(legacy: string, current: string): void {
  try {
    if (existsSync(current) || !existsSync(legacy)) return;
    mkdirSync(dirname(current), { recursive: true });
    renameSync(legacy, current);
  } catch { /* best-effort — a fresh index will just be rebuilt */ }
}
