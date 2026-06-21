import Database from "better-sqlite3";
import { VectorStore } from "@llm-wiki/search";
import type { Contact } from "./types.ts";

export function displayNameOf(c: Contact): string {
  const name = [c.firstName, c.lastName].filter((s) => s && s.trim()).join(" ").trim();
  if (name) return name;
  if (c.organization && c.organization.trim()) return c.organization.trim();
  return c.emails[0]?.address ?? c.uid;
}

export class IndexDb {
  readonly vectors: VectorStore;
  private constructor(private readonly raw: Database.Database) {
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS contacts(
        rowid INTEGER PRIMARY KEY,
        uid TEXT UNIQUE, display_name TEXT, organization TEXT, nickname TEXT, note TEXT,
        primary_email TEXT, source_hash TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(display_name, organization, nickname, note);
      CREATE TABLE IF NOT EXISTS embed_state(uid TEXT PRIMARY KEY, source_hash TEXT, dim INTEGER, model TEXT, embedded_at INTEGER);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
    `);
    this.vectors = new VectorStore(this.raw, {
      table: "vec_contacts",
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

  upsertContact(c: Contact, sourceHash: string): number {
    const dn = displayNameOf(c);
    this.raw.prepare(`
      INSERT INTO contacts(uid,display_name,organization,nickname,note,primary_email,source_hash)
      VALUES (@uid,@dn,@org,@nick,@note,@email,@hash)
      ON CONFLICT(uid) DO UPDATE SET display_name=excluded.display_name, organization=excluded.organization,
        nickname=excluded.nickname, note=excluded.note, primary_email=excluded.primary_email, source_hash=excluded.source_hash`)
      .run({ uid: c.uid, dn, org: c.organization, nick: c.nickname, note: c.note, email: c.emails[0]?.address ?? null, hash: sourceHash });
    const rowid = (this.raw.prepare("SELECT rowid FROM contacts WHERE uid=?").get(c.uid) as { rowid: number }).rowid;
    this.raw.prepare("DELETE FROM contacts_fts WHERE rowid=?").run(rowid);
    this.raw.prepare("INSERT INTO contacts_fts(rowid, display_name, organization, nickname, note) VALUES (?,?,?,?,?)")
      .run(rowid, dn, c.organization ?? "", c.nickname ?? "", c.note ?? "");
    return rowid;
  }

  deleteMissing(keepUids: string[]): number {
    const keep = new Set(keepUids);
    let n = 0;
    const delFts = this.raw.prepare("DELETE FROM contacts_fts WHERE rowid=?");
    const del = this.raw.prepare("DELETE FROM contacts WHERE uid=?");
    const delEmbed = this.raw.prepare("DELETE FROM embed_state WHERE uid=?");
    const sel = this.raw.prepare("SELECT rowid FROM contacts WHERE uid=?");
    for (const uid of this.allUids()) {
      if (keep.has(uid)) continue;
      const row = sel.get(uid) as { rowid: number } | undefined;
      if (row) delFts.run(row.rowid);
      del.run(uid);
      delEmbed.run(uid);
      n++;
    }
    return n;
  }

  allUids(): string[] {
    return (this.raw.prepare("SELECT uid FROM contacts").all() as { uid: string }[]).map((r) => r.uid);
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
      `SELECT c.uid AS uid FROM contacts_fts f JOIN contacts c ON c.rowid = f.rowid
       WHERE contacts_fts MATCH ? ORDER BY rank LIMIT ?`).all(query, limit) as { uid: string }[];
    return rows.map((r) => r.uid);
  }

  rowidToUid(rowid: number): string | undefined {
    return (this.raw.prepare("SELECT uid FROM contacts WHERE rowid=?").get(rowid) as { uid: string } | undefined)?.uid;
  }

  close(): void { this.raw.close(); }
}
