import Database from "better-sqlite3";
import { VectorStore } from "@llm-wiki/search";
import type { CalEvent } from "./types.ts";

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
    this.vectors = new VectorStore(this.raw, {
      table: "vec_events",
      getState: (k) => this.getState(k),
      setState: (k, v) => this.setState(k, v),
      onDimReset: () => this.raw.exec("DELETE FROM embed_state"),
    });
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
      INSERT INTO events(uid,summary,description,location,start,end,all_day,calendar,account,status,url,last_modified,source_hash)
      VALUES (@uid,@summary,@description,@location,@start,@end,@all_day,@calendar,@account,@status,@url,@last_modified,@source_hash)
      ON CONFLICT(uid) DO UPDATE SET summary=excluded.summary, description=excluded.description, location=excluded.location,
        start=excluded.start, end=excluded.end, all_day=excluded.all_day, calendar=excluded.calendar, account=excluded.account,
        status=excluded.status, url=excluded.url, last_modified=excluded.last_modified, source_hash=excluded.source_hash`)
      .run({ ...e, all_day: e.allDay ? 1 : 0, last_modified: e.lastModified, source_hash: sourceHash });
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

  ftsSearch(query: string, limit: number): string[] {
    const rows = this.raw.prepare(
      `SELECT e.uid AS uid FROM events_fts f JOIN events e ON e.rowid = f.rowid
       WHERE events_fts MATCH ? ORDER BY rank LIMIT ?`).all(query, limit) as { uid: string }[];
    return rows.map((r) => r.uid);
  }

  rowidToUid(rowid: number): string | undefined {
    return (this.raw.prepare("SELECT uid FROM events WHERE rowid=?").get(rowid) as { uid: string } | undefined)?.uid;
  }
  uidToRowid(uid: string): number | undefined {
    return (this.raw.prepare("SELECT rowid FROM events WHERE uid=?").get(uid) as { rowid: number } | undefined)?.rowid;
  }

  close(): void { this.raw.close(); }
}
