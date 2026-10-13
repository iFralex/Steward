import Database from "better-sqlite3";
import { VectorStore } from "@steward/search";
import type { CalEvent } from "./types.ts";

/** Candidate-restricting filters, applied to the `events` mirror before ranking. */
export interface EventFilter { account?: string; calendar?: string; startISO?: string; endISO?: string }

export class IndexDb {
  readonly vectors: VectorStore;
  private constructor(private readonly raw: Database.Database) {
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS events(
        rowid INTEGER PRIMARY KEY,
        uid TEXT UNIQUE, summary TEXT, description TEXT, location TEXT,
        start TEXT, end TEXT, all_day INTEGER, calendar TEXT, account TEXT,
        status INTEGER, url TEXT, last_modified REAL, source_hash TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(summary, description, location);
      CREATE TABLE IF NOT EXISTS embed_state(uid TEXT PRIMARY KEY, source_hash TEXT, dim INTEGER, model TEXT, embedded_at INTEGER);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
    `);
    this.ensureEventColumn("calendar_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureEventColumn("alarms_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureEventColumn("has_recurrence", "INTEGER NOT NULL DEFAULT 0");
    this.vectors = new VectorStore(this.raw, {
      table: "vec_events",
      getState: (k) => this.getState(k),
      setState: (k, v) => this.setState(k, v),
      onDimReset: () => this.raw.exec("DELETE FROM embed_state"),
    });
  }

  private ensureEventColumn(name: string, definition: string): void {
    const columns = new Set((this.raw.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((column) => column.name));
    if (!columns.has(name)) this.raw.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
  }

  static open(path: string): IndexDb { return new IndexDb(new Database(path)); }

  getState(key: string): string | undefined {
    return (this.raw.prepare("SELECT value FROM state WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  setState(key: string, value: string): void {
    this.raw.prepare("INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  upsertEvent(e: CalEvent, sourceHash: string): number {
    const info = this.raw.prepare(`
      INSERT INTO events(uid,summary,description,location,start,end,all_day,calendar_id,calendar,account,alarms_json,has_recurrence,status,url,last_modified,source_hash)
      VALUES (@uid,@summary,@description,@location,@start,@end,@all_day,@calendar_id,@calendar,@account,@alarms_json,@has_recurrence,@status,@url,@last_modified,@source_hash)
      ON CONFLICT(uid) DO UPDATE SET summary=excluded.summary, description=excluded.description, location=excluded.location,
        start=excluded.start, end=excluded.end, all_day=excluded.all_day, calendar_id=excluded.calendar_id,
        calendar=excluded.calendar, account=excluded.account, alarms_json=excluded.alarms_json, has_recurrence=excluded.has_recurrence,
        status=excluded.status, url=excluded.url, last_modified=excluded.last_modified, source_hash=excluded.source_hash`)
      .run({
        ...e,
        all_day: e.allDay ? 1 : 0,
        calendar_id: e.calendarId,
        alarms_json: JSON.stringify(e.alarms),
        has_recurrence: e.hasRecurrence ? 1 : 0,
        last_modified: e.lastModified,
        source_hash: sourceHash,
      });
    void info;
    const rowid = (this.raw.prepare("SELECT rowid FROM events WHERE uid=?").get(e.uid) as { rowid: number }).rowid;
    // keep the standalone FTS row at the same rowid in sync
    this.raw.prepare("DELETE FROM events_fts WHERE rowid=?").run(rowid);
    this.raw.prepare("INSERT INTO events_fts(rowid, summary, description, location) VALUES (?,?,?,?)")
      .run(rowid, e.summary, e.description ?? "", e.location ?? "");
    return rowid;
  }

  deleteMissing(keepUids: string[]): number {
    const keep = new Set(keepUids);
    const all = this.allUids();
    let n = 0;
    const del = this.raw.prepare("DELETE FROM events WHERE uid=?");
    const delFts = this.raw.prepare("DELETE FROM events_fts WHERE rowid=?");
    for (const uid of all) {
      if (keep.has(uid)) continue;
      const row = this.raw.prepare("SELECT rowid FROM events WHERE uid=?").get(uid) as { rowid: number } | undefined;
      if (row) delFts.run(row.rowid);
      del.run(uid);
      this.raw.prepare("DELETE FROM embed_state WHERE uid=?").run(uid);
      n++;
    }
    return n;
  }

  allUids(): string[] {
    return (this.raw.prepare("SELECT uid FROM events").all() as { uid: string }[]).map((r) => r.uid);
  }

  embedStateFor(uid: string): { sourceHash: string } | undefined {
    const r = this.raw.prepare("SELECT source_hash FROM embed_state WHERE uid=?").get(uid) as { source_hash: string } | undefined;
    return r ? { sourceHash: r.source_hash } : undefined;
  }
  recordEmbed(uid: string, sourceHash: string, dim: number, model: string): void {
    this.raw.prepare(`INSERT INTO embed_state(uid,source_hash,dim,model,embedded_at) VALUES (?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET source_hash=excluded.source_hash, dim=excluded.dim, model=excluded.model, embedded_at=excluded.embedded_at`)
      .run(uid, sourceHash, dim, model, Math.floor(Date.now() / 1000));
  }

  /** SQL fragment (" AND …") + params restricting the `events` mirror by filter. Empty when no fields set. */
  private filterClause(f?: EventFilter): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (f?.account) { clauses.push("e.account = ?"); params.push(f.account); }
    if (f?.calendar) { clauses.push("e.calendar = ?"); params.push(f.calendar); }
    if (f?.startISO) { clauses.push("e.start >= ?"); params.push(f.startISO); }
    if (f?.endISO) { clauses.push("e.start <= ?"); params.push(f.endISO); }
    return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
  }

  /** The set of uids matching `filter`, or null when the filter restricts nothing. */
  allowedUids(filter?: EventFilter): Set<string> | null {
    const { sql, params } = this.filterClause(filter);
    if (!sql) return null;
    const rows = this.raw.prepare(`SELECT e.uid AS uid FROM events e WHERE 1=1${sql}`).all(...params) as { uid: string }[];
    return new Set(rows.map((r) => r.uid));
  }

  ftsSearch(query: string, limit: number, filter?: EventFilter): string[] {
    const { sql, params } = this.filterClause(filter);
    const rows = this.raw.prepare(
      `SELECT e.uid AS uid FROM events_fts f JOIN events e ON e.rowid = f.rowid
       WHERE events_fts MATCH ?${sql} ORDER BY rank LIMIT ?`).all(query, ...params, limit) as { uid: string }[];
    return rows.map((r) => r.uid);
  }

  rowidToUid(rowid: number): string | undefined {
    return (this.raw.prepare("SELECT uid FROM events WHERE rowid=?").get(rowid) as { uid: string } | undefined)?.uid;
  }
  uidToRowid(uid: string): number | undefined {
    return (this.raw.prepare("SELECT rowid FROM events WHERE uid=?").get(uid) as { rowid: number } | undefined)?.rowid;
  }
  getEvent(uid: string): CalEvent | null {
    const row = this.raw.prepare("SELECT * FROM events WHERE uid=?").get(uid) as
      | {
          uid: string; summary: string; description: string | null; location: string | null;
          start: string; end: string; all_day: number; calendar_id: string; calendar: string; account: string;
          alarms_json: string; has_recurrence: number;
          status: number; url: string | null; last_modified: number;
        }
      | undefined;
    if (!row) return null;
    return {
      uid: row.uid,
      summary: row.summary,
      description: row.description,
      location: row.location,
      start: row.start,
      end: row.end,
      allDay: !!row.all_day,
      calendarId: row.calendar_id,
      calendar: row.calendar,
      account: row.account,
      alarms: JSON.parse(row.alarms_json) as number[],
      hasRecurrence: !!row.has_recurrence,
      status: row.status,
      url: row.url,
      lastModified: row.last_modified,
    };
  }

  close(): void { this.raw.close(); }
}
