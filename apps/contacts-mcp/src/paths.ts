import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

/** Every per-source AddressBook store that exists, newest layout first. */
export function sourceDbPaths(): string[] {
  const base = join(homedir(), "Library", "Application Support", "AddressBook");
  const out: string[] = [];
  const sources = join(base, "Sources");
  if (existsSync(sources)) {
    for (const uuid of readdirSync(sources)) {
      const db = join(sources, uuid, "AddressBook-v22.abcddb");
      if (existsSync(db)) out.push(db);
    }
  }
  const top = join(base, "AddressBook-v22.abcddb");
  if (existsSync(top)) out.push(top);
  return out;
}

export function indexDbPath(): string {
  return process.env.CONTACTS_INDEX_DB
    ?? join(homedir(), "Library", "Application Support", "llm-wiki", "contacts-index.sqlitedb");
}
