import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readdirSync, mkdirSync, renameSync } from "node:fs";

/** Every per-source AddressBook store that exists, newest layout first. */
export function sourceDbPaths(): string[] {
  const base = join(homedir(), "Library", "Application Support", "AddressBook");
  const out: string[] = [];
  const sources = join(base, "Sources");
  if (existsSync(sources)) {
    try {
      for (const uuid of readdirSync(sources)) {
        const db = join(sources, uuid, "AddressBook-v22.abcddb");
        if (existsSync(db)) out.push(db);
      }
    } catch {
      // macOS can deny AddressBook/Sources without Full Disk Access. Keep the
      // MCP server alive so write tools and permission diagnostics still work.
    }
  }
  const top = join(base, "AddressBook-v22.abcddb");
  if (existsSync(top)) out.push(top);
  return out;
}

export function indexDbPath(): string {
  if (process.env.CONTACTS_INDEX_DB) return process.env.CONTACTS_INDEX_DB;
  const support = join(homedir(), "Library", "Application Support");
  const current = join(support, "steward", "contacts-index.sqlitedb");
  migrateLegacyIndex(join(support, "llm-wiki", "contacts-index.sqlitedb"), current);
  return current;
}

/** One-time, non-destructive migration after the LLM Wiki → Steward rename. The
 *  index is rebuildable from AddressBook, so this is best-effort. */
function migrateLegacyIndex(legacy: string, current: string): void {
  try {
    if (existsSync(current) || !existsSync(legacy)) return;
    mkdirSync(dirname(current), { recursive: true });
    renameSync(legacy, current);
  } catch { /* best-effort — a fresh index will just be rebuilt */ }
}
