import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { indexDbPath } from "../../calendar-mcp/src/paths.ts";
import { unixToCoreData } from "../../calendar-mcp/src/coredata.ts";
import type { ActionStore } from "./store.ts";

export interface CalendarScanResult { considered: number; created: number; updated: number }

export function scanCalendarForActions(deps: {
  actions: ActionStore;
  calendarDbPath?: string;
  now?: Date;
  horizonDays?: number;
  /** Ignore events last modified at or before this Unix timestamp. */
  modifiedAfter?: number;
}): CalendarScanResult {
  const path = deps.calendarDbPath ?? indexDbPath();
  if (!existsSync(path)) return { considered: 0, created: 0, updated: 0 };
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const now = deps.now ?? new Date();
    const end = new Date(now.getTime() + (deps.horizonDays ?? 3) * 86400_000);
    const modifiedClause = typeof deps.modifiedAfter === "number" ? "AND last_modified > ?" : "";
    const params: unknown[] = [now.toISOString(), end.toISOString()];
    if (typeof deps.modifiedAfter === "number") params.push(unixToCoreData(deps.modifiedAfter));
    const rows = db.prepare(
      `SELECT uid, summary, description, location, start, end, all_day, calendar, account, url
       FROM events
       WHERE start >= ? AND start <= ? AND COALESCE(status, 1) != 3 ${modifiedClause}
       ORDER BY start ASC`,
    ).all(...params) as {
      uid: string; summary: string | null; description: string | null; location: string | null;
      start: string; end: string; all_day: number; calendar: string | null; account: string | null; url: string | null;
    }[];
    const result: CalendarScanResult = { considered: rows.length, created: 0, updated: 0 };
    for (const ev of rows) {
      const start = Date.parse(ev.start);
      const upsert = deps.actions.upsert({
        sourceKey: `calendar:${ev.uid}:${ev.start}`,
        sourceKind: "calendar",
        kind: "event-reminder",
        priority: start - now.getTime() <= 24 * 3600_000 ? "high" : "normal",
        title: `Upcoming: ${ev.summary ?? "(untitled event)"}`,
        summary: summarizeEvent(ev),
        dueAt: Number.isFinite(start) ? Math.floor(start / 1000) : null,
        payload: {
          uid: ev.uid,
          summary: ev.summary,
          start: ev.start,
          end: ev.end,
          allDay: !!ev.all_day,
          location: ev.location,
          calendar: ev.calendar,
          account: ev.account,
          url: ev.url,
        },
      });
      if (upsert.inserted) result.created++;
      else if (upsert.updated) result.updated++;
    }
    return result;
  } finally {
    db.close();
  }
}

function summarizeEvent(ev: { summary: string | null; start: string; end: string; location: string | null }): string {
  const when = new Date(ev.start).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
  const where = ev.location ? ` at ${ev.location}` : "";
  return `${ev.summary ?? "Event"} — ${when}${where}.`;
}
