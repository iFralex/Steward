import { homedir } from "node:os";
import { join } from "node:path";

export function applePath(): string {
  return join(homedir(), "Library", "Group Containers", "group.com.apple.calendar", "Calendar.sqlitedb");
}

export function indexDbPath(): string {
  return process.env.CALENDAR_INDEX_DB ?? join(homedir(), "Library", "Application Support", "llm-wiki", "calendar-index.sqlitedb");
}
