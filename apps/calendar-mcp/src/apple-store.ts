import Database from "better-sqlite3";
import { coreDataToISO, isoToUnix, unixToCoreData } from "./coredata.ts";
import type { CalEvent, CalendarInfo } from "./types.ts";

const SELECT = `
  SELECT ci.UUID AS uid, ci.external_id AS external_id, ci.summary AS summary, ci.description AS description,
         l.title AS location, ci.start_date AS start_cd, ci.end_date AS end_cd,
         ci.all_day AS all_day, c.UUID AS calendar_uuid, c.title AS calendar, s.name AS account,
         ci.has_recurrences AS has_recurrences,
         COALESCE((
           SELECT json_group_array(minutes_before)
           FROM (
             SELECT CAST(-a.trigger_interval / 60 AS INTEGER) AS minutes_before
             FROM Alarm a
             WHERE a.calendaritem_owner_id = ci.ROWID
               AND a.type = 0
               AND COALESCE(a.default_alarm, 0) = 0
               AND a.trigger_interval IS NOT NULL
             ORDER BY a.ROWID
           )
         ), '[]') AS alarms_json,
         ci.status AS status, ci.url AS url, ci.last_modified AS last_modified
  FROM CalendarItem ci
  JOIN Calendar c ON c.ROWID = ci.calendar_id
  JOIN Store s ON s.ROWID = c.store_id
  LEFT JOIN Location l ON l.ROWID = ci.location_id
  WHERE ci.entity_type = 2`;

function toEvent(r: Record<string, unknown>): CalEvent {
  let alarms: number[] = [];
  try {
    const parsed = JSON.parse(String(r.alarms_json ?? "[]"));
    if (Array.isArray(parsed)) alarms = parsed.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  } catch { /* malformed Calendar data is treated as no explicit alarms */ }
  return {
    uid: String(r.uid ?? ""),
    externalId: (r.external_id as string) ?? null,
    summary: String(r.summary ?? ""),
    description: (r.description as string) ?? null,
    location: (r.location as string) ?? null,
    start: coreDataToISO(Number(r.start_cd)),
    end: coreDataToISO(Number(r.end_cd ?? r.start_cd)),
    allDay: Number(r.all_day) === 1,
    calendarId: String(r.calendar_uuid ?? ""),
    calendar: String(r.calendar ?? ""),
    account: String(r.account ?? ""),
    alarms,
    hasRecurrence: Number(r.has_recurrences) === 1,
    status: Number(r.status ?? 0),
    url: (r.url as string) ?? null,
    lastModified: Number(r.last_modified ?? 0),
  };
}

export class AppleStore {
  private constructor(private readonly db: Database.Database) {}

  static openReadonly(path: string): AppleStore {
    return new AppleStore(new Database(path, { readonly: true, fileMustExist: true }));
  }

  listCalendars(): CalendarInfo[] {
    const rows = this.db.prepare(
      `SELECT c.UUID AS id, c.title AS title, s.name AS account, c.type AS type
       FROM Calendar c JOIN Store s ON s.ROWID = c.store_id ORDER BY s.name, c.title`,
    ).all() as Record<string, unknown>[];
    return rows.map((r) => ({ id: String(r.id ?? ""), title: String(r.title ?? ""), account: String(r.account ?? ""), type: Number(r.type ?? 0) }));
  }

  eventsInRange(opts: { startISO: string; endISO: string; account?: string; calendar?: string }): CalEvent[] {
    const startCd = unixToCoreData(isoToUnix(opts.startISO));
    const endCd = unixToCoreData(isoToUnix(opts.endISO));
    const where: string[] = ["COALESCE(ci.end_date, ci.start_date) > ?", "ci.start_date < ?"];
    const params: unknown[] = [startCd, endCd];
    if (opts.account) { where.push("s.name = ?"); params.push(opts.account); }
    if (opts.calendar) { where.push("c.title = ?"); params.push(opts.calendar); }
    const sql = `${SELECT} AND ${where.join(" AND ")} ORDER BY ci.start_date LIMIT 1000`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toEvent);
  }

  getEvent(uid: string): CalEvent | undefined {
    const r = this.db.prepare(`${SELECT} AND ci.UUID = ? LIMIT 1`).get(uid) as Record<string, unknown> | undefined;
    return r ? toEvent(r) : undefined;
  }

  /** Every event, for full (re)indexing. */
  allForIndex(): CalEvent[] {
    return (this.db.prepare(`${SELECT} ORDER BY ci.start_date`).all() as Record<string, unknown>[]).map(toEvent);
  }

  close(): void { this.db.close(); }
}
