import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { indexDbPath } from "../../calendar-mcp/src/paths.ts";
import { unixToCoreData } from "../../calendar-mcp/src/coredata.ts";
import type { ActionStore } from "./store.ts";
import type { ActionTextLanguage } from "./types.ts";

export interface CalendarScanResult { considered: number; created: number; updated: number }

export function scanCalendarForActions(deps: {
  actions: ActionStore;
  calendarDbPath?: string;
  now?: Date;
  horizonDays?: number;
  /** Ignore events last modified at or before this Unix timestamp. */
  modifiedAfter?: number;
  textLanguage?: ActionTextLanguage;
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
    const hasRefId = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).some(column => column.name === 'ref_id');
    const rows = db.prepare(
      `SELECT uid, ${hasRefId ? "ref_id" : "NULL"} AS ref_id, summary, description, location, start, end, all_day, calendar, account, url
       FROM events
       WHERE start >= ? AND start <= ? AND COALESCE(status, 1) != 3 ${modifiedClause}
       ORDER BY start ASC`,
    ).all(...params) as {
      uid: string; ref_id: string | null; summary: string | null; description: string | null; location: string | null;
      start: string; end: string; all_day: number; calendar: string | null; account: string | null; url: string | null;
    }[];
    const result: CalendarScanResult = { considered: rows.length, created: 0, updated: 0 };
    for (const ev of rows) {
      const start = Date.parse(ev.start);
      const sourceKey = `calendar:${ev.ref_id ?? ev.uid}`;
      // Migrate a uniquely identifiable legacy reminder without losing review state.
      const aliases = hasRefId && ev.ref_id
        ? (db.prepare('SELECT uid FROM event_uid_aliases WHERE ref_id=?').all(ev.ref_id) as {uid:string}[]).map(row => row.uid)
        : [ev.uid];
      const prior = deps.actions.raw.prepare("SELECT id,source_key,payload FROM actions WHERE source_kind='calendar'").all() as {id:number;source_key:string;payload:string}[];
      const matches = prior.filter(row => { try { const p = JSON.parse(row.payload); return row.source_key === sourceKey || aliases.includes(p.uid) || p.refId === ev.ref_id && ev.ref_id !== null; } catch { return false; } });
      if (matches.length === 1 && matches[0].source_key !== sourceKey) {
        deps.actions.raw.prepare('UPDATE actions SET source_key=? WHERE id=?').run(sourceKey, matches[0].id);
      }
      const upsert = deps.actions.upsert({
        sourceKey,
        sourceKind: "calendar",
        kind: "event-reminder",
        priority: start - now.getTime() <= 24 * 3600_000 ? "high" : "normal",
        title: calendarActionTitle(ev.summary, deps.textLanguage ?? "default"),
        summary: summarizeEvent(ev, deps.textLanguage ?? "default"),
        dueAt: Number.isFinite(start) ? Math.floor(start / 1000) : null,
        payload: {
          uid: ev.uid,
          refId: ev.ref_id,
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

function calendarActionTitle(summary: string | null, language: ActionTextLanguage): string {
  if (language === "it") return `In arrivo: ${summary ?? "(evento senza titolo)"}`;
  return `Upcoming: ${summary ?? "(untitled event)"}`;
}

function summarizeEvent(
  ev: { summary: string | null; start: string; end: string; location: string | null },
  language: ActionTextLanguage,
): string {
  const locale = language === "en" ? "en-GB" : "it-IT";
  const when = new Date(ev.start).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  const fallback = language === "it" ? "Evento" : "Event";
  const where = ev.location ? language === "it" ? ` presso ${ev.location}` : ` at ${ev.location}` : "";
  return `${ev.summary ?? fallback} — ${when}${where}.`;
}
