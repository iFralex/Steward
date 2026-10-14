import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
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
    this.ensureEventColumn("external_id", "TEXT");
    this.ensureEventColumn("ref_id", "TEXT");
    this.ensureEventColumn("seen_generation", "INTEGER NOT NULL DEFAULT 0");
    this.raw.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_ref_id ON events(ref_id) WHERE ref_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS event_uid_aliases(
        uid TEXT PRIMARY KEY,
        ref_id TEXT NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_alias_ref ON event_uid_aliases(ref_id);
    `);
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

  beginSyncGeneration(): number {
    const generation = Number(this.getState("sync_generation") ?? "0") + 1;
    this.setState("sync_generation", String(generation));
    return generation;
  }

  transaction<T>(work: () => T): T { return this.raw.transaction(work).immediate(); }

  finishSyncGeneration(generation: number, startedAt: number): void {
    this.setState('completed_sync_generation', String(generation));
    this.setState('completed_sync_started_at', String(startedAt));
  }

  refIdForUid(uid: string): string | undefined {
    return (this.raw.prepare('SELECT ref_id FROM event_uid_aliases WHERE uid=?').get(uid) as {ref_id:string} | undefined)?.ref_id;
  }

  upsertEvent(e: CalEvent, sourceHash: string, generation = 0): number {
    const identity = this.resolveIdentity(e, generation);
    if (identity.previousUid && identity.previousUid !== e.uid) {
      // Preserve rowid/vector identity while rebinding a server event to the
      // fresh local UUID assigned by a full account sync.
      this.raw.prepare("UPDATE events SET uid=? WHERE uid=?").run(e.uid, identity.previousUid);
      this.raw.prepare("UPDATE embed_state SET uid=? WHERE uid=?").run(e.uid, identity.previousUid);
    }
    const info = this.raw.prepare(`
      INSERT INTO events(uid,external_id,ref_id,seen_generation,summary,description,location,start,end,all_day,calendar_id,calendar,account,alarms_json,has_recurrence,status,url,last_modified,source_hash)
      VALUES (@uid,@external_id,@ref_id,@seen_generation,@summary,@description,@location,@start,@end,@all_day,@calendar_id,@calendar,@account,@alarms_json,@has_recurrence,@status,@url,@last_modified,@source_hash)
      ON CONFLICT(uid) DO UPDATE SET summary=excluded.summary, description=excluded.description, location=excluded.location,
        start=excluded.start, end=excluded.end, all_day=excluded.all_day, calendar_id=excluded.calendar_id,
        calendar=excluded.calendar, account=excluded.account, alarms_json=excluded.alarms_json, has_recurrence=excluded.has_recurrence,
        external_id=excluded.external_id, ref_id=excluded.ref_id, seen_generation=excluded.seen_generation,
        status=excluded.status, url=excluded.url, last_modified=excluded.last_modified, source_hash=excluded.source_hash`)
      .run({
        ...e,
        external_id: e.externalId ?? null,
        ref_id: identity.refId,
        seen_generation: generation,
        all_day: e.allDay ? 1 : 0,
        calendar_id: e.calendarId,
        alarms_json: JSON.stringify(e.alarms),
        has_recurrence: e.hasRecurrence ? 1 : 0,
        last_modified: e.lastModified,
        source_hash: sourceHash,
      });
    const now = Math.floor(Date.now() / 1000);
    const alias = this.raw.prepare(`INSERT INTO event_uid_aliases(uid,ref_id,last_seen) VALUES (?,?,?)
      ON CONFLICT(uid) DO UPDATE SET ref_id=excluded.ref_id,last_seen=excluded.last_seen`);
    alias.run(e.uid, identity.refId, now);
    if (identity.previousUid) alias.run(identity.previousUid, identity.refId, now);
    void info;
    const rowid = (this.raw.prepare("SELECT rowid FROM events WHERE uid=?").get(e.uid) as { rowid: number }).rowid;
    // keep the standalone FTS row at the same rowid in sync
    this.raw.prepare("DELETE FROM events_fts WHERE rowid=?").run(rowid);
    this.raw.prepare("INSERT INTO events_fts(rowid, summary, description, location) VALUES (?,?,?,?)")
      .run(rowid, e.summary, e.description ?? "", e.location ?? "");
    return rowid;
  }

  private resolveIdentity(e: CalEvent, generation: number): { refId: string; previousUid?: string } {
    const direct = this.raw.prepare("SELECT ref_id FROM events WHERE uid=?").get(e.uid) as { ref_id: string | null } | undefined;
    if (direct) return { refId: direct.ref_id ?? randomUUID() };

    const knownAlias = this.raw.prepare("SELECT ref_id FROM event_uid_aliases WHERE uid=?").get(e.uid) as { ref_id: string } | undefined;
    if (knownAlias) {
      const current = this.raw.prepare("SELECT uid FROM events WHERE ref_id=?").get(knownAlias.ref_id) as { uid: string } | undefined;
      return { refId: knownAlias.ref_id, previousUid: current?.uid };
    }

    const candidates = e.externalId
      ? this.raw.prepare(`SELECT uid,ref_id FROM events
          WHERE external_id=? AND account=? AND calendar=? AND start=? AND seen_generation<>?`).all(e.externalId, e.account, e.calendar, e.start, generation)
      : this.raw.prepare(`SELECT uid,ref_id FROM events
          WHERE account=? AND calendar=? AND start=? AND end=? AND all_day=? AND summary=?
            AND COALESCE(location,'')=COALESCE(?, '') AND seen_generation<>?`).all(
          e.account, e.calendar, e.start, e.end, e.allDay ? 1 : 0, e.summary, e.location, generation,
        );
    const matches = candidates as { uid: string; ref_id: string | null }[];
    if (matches.length === 1) return { refId: matches[0].ref_id ?? randomUUID(), previousUid: matches[0].uid };
    return { refId: randomUUID() };
  }

  /** Resolve a current or historical Calendar UUID to the current local UUID. */
  resolveUid(uid: string): string | undefined {
    if (this.raw.prepare("SELECT 1 FROM events WHERE uid=?").get(uid)) return uid;
    return (this.raw.prepare(`SELECT e.uid FROM event_uid_aliases a JOIN events e ON e.ref_id=a.ref_id
      WHERE a.uid=?`).get(uid) as { uid: string } | undefined)?.uid;
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
    if (f?.startISO) { clauses.push("e.end > ?"); params.push(f.startISO); }
    if (f?.endISO) { clauses.push("e.start < ?"); params.push(f.endISO); }
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
          uid: string; external_id: string | null; summary: string; description: string | null; location: string | null;
          start: string; end: string; all_day: number; calendar_id: string; calendar: string; account: string;
          alarms_json: string; has_recurrence: number;
          status: number; url: string | null; last_modified: number;
        }
      | undefined;
    if (!row) return null;
    return {
      uid: row.uid,
      refId: this.refIdForUid(row.uid),
      ...(row.external_id == null ? {} : { externalId: row.external_id }),
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

  /** Narrow candidates for recovering a create whose caller crashed before receiving its uid. */
  writeConfirmationCandidates(expected: Record<string, unknown>): CalEvent[] {
    const summary = typeof expected.summary === "string" ? expected.summary : "";
    if (!summary) return [];
    const clauses = ["summary=?"];
    const params: unknown[] = [summary];
    if (typeof expected.calendarId === "string" && expected.calendarId) {
      clauses.push("calendar_id=?"); params.push(expected.calendarId);
    } else if (typeof expected.calendar === "string" && expected.calendar) {
      clauses.push("calendar=?"); params.push(expected.calendar);
    }
    const rows = this.raw.prepare(`SELECT uid FROM events WHERE ${clauses.join(" AND ")} LIMIT 20`).all(...params) as { uid: string }[];
    return rows.map((row) => this.getEvent(row.uid)).filter((event): event is CalEvent => event !== null);
  }

  close(): void { this.raw.close(); }
}
