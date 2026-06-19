import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type BodyState = "full" | "partial" | "none";

export interface MessageRow {
  messageId: string;
  account: string;
  mailbox: string;
  fromName: string;
  fromAddr: string;
  to: string[];
  cc: string[];
  subject: string;
  date: number;
  bodyText: string;
  bodyState: BodyState;
  source: "emlx" | "applescript";
  emlxPath: string | null;
  inReplyTo: string | null;
  references: string[];
  gmThrid: string | null;
  size: number;
  toNames: string[];
  ccNames: string[];
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  junk: boolean;
  flagColor: number | null;
  appleThrid: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY, account TEXT NOT NULL, mailbox TEXT,
  from_name TEXT, from_addr TEXT, to_addrs TEXT, cc_addrs TEXT,
  subject TEXT, date INTEGER, snippet TEXT, body_text TEXT,
  body_state TEXT NOT NULL, source TEXT NOT NULL, emlx_path TEXT,
  in_reply_to TEXT, reference_ids TEXT, gm_thrid TEXT, thread_id INTEGER,
  flagged INTEGER DEFAULT 0, unread INTEGER DEFAULT 0, size INTEGER,
  deleted INTEGER DEFAULT 0, ingested_at INTEGER, updated_at INTEGER,
  answered INTEGER DEFAULT 0, junk INTEGER DEFAULT 0, flag_color INTEGER, apple_thrid INTEGER,
  to_names TEXT, cc_names TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_account_date ON messages(account, date);
CREATE INDEX IF NOT EXISTS idx_messages_emlx_path ON messages(emlx_path);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, from_addr, from_name, to_addrs, body_text
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, mime TEXT,
  size INTEGER, sha256 TEXT NOT NULL, blob_path TEXT, downloaded INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_att_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_att_sha ON attachments(sha256);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY, subject TEXT, participants TEXT,
  first_date INTEGER, last_date INTEGER, msg_count INTEGER
);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS message_paths (
  path TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  mailbox TEXT,
  is_partial INTEGER DEFAULT 0,
  mtime_ms REAL
);
CREATE INDEX IF NOT EXISTS idx_mpaths_message ON message_paths(message_id);
CREATE TABLE IF NOT EXISTS embed_state (
  message_id TEXT PRIMARY KEY, model TEXT, dim INTEGER, source_hash TEXT, embedded_at INTEGER
);
CREATE TABLE IF NOT EXISTS accounts (
  uuid TEXT PRIMARY KEY, name TEXT, emails TEXT
);
CREATE TABLE IF NOT EXISTS mailbox_roles (
  account_uuid TEXT NOT NULL, mailbox_name TEXT NOT NULL, role TEXT,
  PRIMARY KEY (account_uuid, mailbox_name)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_trig USING fts5(
  from_name, from_addr, to_names, to_addrs, cc_names, cc_addrs, subject, body_text,
  tokenize='trigram'
);
`;

export class Store {
  raw: Database.Database;
  private vecLoaded = false;

  constructor(db: Database.Database, opts: { readonly?: boolean } = {}) {
    this.raw = db;
    if (!opts.readonly) {
      db.pragma("journal_mode = WAL");
      db.exec(SCHEMA);
      this.migrate();
    }
  }

  /** Idempotently add columns absent from a pre-enrichment DB. CREATE ... IF NOT EXISTS in SCHEMA covers tables. */
  private migrate(): void {
    const have = new Set(
      (this.raw.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((r) => r.name),
    );
    const add: [string, string][] = [
      ["answered", "INTEGER DEFAULT 0"], ["junk", "INTEGER DEFAULT 0"],
      ["flag_color", "INTEGER"], ["apple_thrid", "INTEGER"],
      ["to_names", "TEXT"], ["cc_names", "TEXT"],
    ];
    for (const [col, type] of add) {
      if (!have.has(col)) this.raw.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
    }
    const mp = new Set((this.raw.prepare("PRAGMA table_info(message_paths)").all() as { name: string }[]).map((r) => r.name));
    if (!mp.has("mtime_ms")) this.raw.exec("ALTER TABLE message_paths ADD COLUMN mtime_ms REAL");
  }

  static open(path: string): Store {
    return new Store(new Database(path));
  }

  static openReadonly(path: string): Store {
    return new Store(new Database(path, { readonly: true, fileMustExist: true }), { readonly: true });
  }

  upsertMessage(r: MessageRow): void {
    const snippet = r.bodyText.slice(0, 200);
    const now = Math.floor(Date.now() / 1000);
    this.raw
      .prepare(
        `INSERT INTO messages (message_id, account, mailbox, from_name, from_addr, to_addrs, cc_addrs,
           subject, date, snippet, body_text, body_state, source, emlx_path, in_reply_to, reference_ids,
           gm_thrid, size, deleted, ingested_at, updated_at,
           to_names, cc_names, unread, flagged, answered, junk, flag_color, apple_thrid)
         VALUES (@message_id,@account,@mailbox,@from_name,@from_addr,@to_addrs,@cc_addrs,
           @subject,@date,@snippet,@body_text,@body_state,@source,@emlx_path,@in_reply_to,@reference_ids,
           @gm_thrid,@size,0,@now,@now,
           @to_names,@cc_names,@unread,@flagged,@answered,@junk,@flag_color,@apple_thrid)
         ON CONFLICT(message_id) DO UPDATE SET
           account=excluded.account, mailbox=excluded.mailbox, from_name=excluded.from_name,
           from_addr=excluded.from_addr, to_addrs=excluded.to_addrs, cc_addrs=excluded.cc_addrs,
           subject=excluded.subject, date=excluded.date, snippet=excluded.snippet,
           body_text=excluded.body_text, body_state=excluded.body_state, source=excluded.source,
           emlx_path=excluded.emlx_path, in_reply_to=excluded.in_reply_to,
           reference_ids=excluded.reference_ids, gm_thrid=excluded.gm_thrid, size=excluded.size,
           deleted=0, updated_at=@now,
           to_names=excluded.to_names, cc_names=excluded.cc_names, unread=excluded.unread,
           flagged=excluded.flagged, answered=excluded.answered, junk=excluded.junk,
           flag_color=excluded.flag_color, apple_thrid=excluded.apple_thrid`,
      )
      .run({
        message_id: r.messageId, account: r.account, mailbox: r.mailbox,
        from_name: r.fromName, from_addr: r.fromAddr,
        to_addrs: JSON.stringify(r.to), cc_addrs: JSON.stringify(r.cc),
        subject: r.subject, date: r.date, snippet, body_text: r.bodyText,
        body_state: r.bodyState, source: r.source, emlx_path: r.emlxPath,
        in_reply_to: r.inReplyTo, reference_ids: JSON.stringify(r.references),
        gm_thrid: r.gmThrid, size: r.size, now,
        to_names: JSON.stringify(r.toNames), cc_names: JSON.stringify(r.ccNames),
        unread: r.unread ? 1 : 0, flagged: r.flagged ? 1 : 0,
        answered: r.answered ? 1 : 0, junk: r.junk ? 1 : 0,
        flag_color: r.flagColor, apple_thrid: r.appleThrid,
      });
    this.reindexFts(r.messageId);
    this.reindexTrig(r.messageId);
  }

  private reindexTrig(messageId: string): void {
    const m = this.raw.prepare(
      "SELECT rowid, from_name, from_addr, to_names, to_addrs, cc_names, cc_addrs, subject, body_text FROM messages WHERE message_id=?",
    ).get(messageId) as
      | { rowid: number; from_name: string; from_addr: string; to_names: string; to_addrs: string; cc_names: string; cc_addrs: string; subject: string; body_text: string }
      | undefined;
    if (!m) return;
    this.raw.prepare("DELETE FROM messages_trig WHERE rowid=?").run(m.rowid);
    this.raw.prepare(
      "INSERT INTO messages_trig(rowid, from_name, from_addr, to_names, to_addrs, cc_names, cc_addrs, subject, body_text) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(m.rowid, m.from_name, m.from_addr, m.to_names, m.to_addrs, m.cc_names, m.cc_addrs, m.subject, m.body_text);
  }

  /** Substring/fuzzy match in one trigram field. `field` must be a known column name. */
  searchTrig(field: string, needle: string, limit: number): MessageRow[] {
    const cols = new Set(["from_name", "from_addr", "to_names", "to_addrs", "cc_names", "cc_addrs", "subject", "body_text"]);
    if (!cols.has(field)) throw new Error(`unknown trigram field: ${field}`);
    const rows = this.raw.prepare(
      `SELECT m.* FROM messages_trig t JOIN messages m ON m.rowid=t.rowid
       WHERE t.${field} MATCH ? AND m.deleted=0 ORDER BY rank LIMIT ?`,
    ).all(`"${needle.replace(/"/g, '""')}"`, limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  private reindexFts(messageId: string): void {
    const m = this.raw.prepare("SELECT rowid, subject, from_addr, from_name, to_addrs, body_text FROM messages WHERE message_id=?").get(messageId) as
      | { rowid: number; subject: string; from_addr: string; from_name: string; to_addrs: string; body_text: string }
      | undefined;
    if (!m) return;
    this.raw.prepare("DELETE FROM messages_fts WHERE rowid=?").run(m.rowid);
    this.raw
      .prepare("INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addrs, body_text) VALUES (?,?,?,?,?,?)")
      .run(m.rowid, m.subject, m.from_addr, m.from_name, m.to_addrs, m.body_text);
  }

  insertAttachments(messageId: string, atts: { filename: string; mime: string; size: number; sha256: string; relPath: string; downloaded: boolean }[]): void {
    this.raw.prepare("DELETE FROM attachments WHERE message_id=?").run(messageId);
    const ins = this.raw.prepare("INSERT INTO attachments (message_id, filename, mime, size, sha256, blob_path, downloaded) VALUES (?,?,?,?,?,?,?)");
    for (const a of atts) ins.run(messageId, a.filename, a.mime, a.size, a.sha256, a.relPath, a.downloaded ? 1 : 0);
  }

  setThreadId(messageId: string, threadId: number): void {
    this.raw.prepare("UPDATE messages SET thread_id=? WHERE message_id=?").run(threadId, messageId);
  }

  getMessage(messageId: string): MessageRow | undefined {
    const m = this.raw.prepare("SELECT * FROM messages WHERE message_id=?").get(messageId) as Record<string, unknown> | undefined;
    return m ? rowToMessage(m) : undefined;
  }

  searchFts(query: string, limit: number): MessageRow[] {
    const rows = this.raw
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
         WHERE messages_fts MATCH ? AND m.deleted=0 ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  softDelete(messageId: string): void {
    this.raw.prepare("UPDATE messages SET deleted=1, updated_at=? WHERE message_id=?").run(Math.floor(Date.now() / 1000), messageId);
  }

  getMessageIdByPath(emlxPath: string): string | undefined {
    const r = this.raw
      .prepare("SELECT message_id FROM messages WHERE emlx_path=? AND deleted=0")
      .get(emlxPath) as { message_id: string } | undefined;
    return r?.message_id;
  }

  recordPath(messageId: string, path: string, mailbox: string, isPartial: boolean, mtimeMs?: number): void {
    this.raw
      .prepare(
        `INSERT INTO message_paths(path, message_id, mailbox, is_partial, mtime_ms) VALUES(?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET message_id=excluded.message_id, mailbox=excluded.mailbox,
           is_partial=excluded.is_partial, mtime_ms=excluded.mtime_ms`,
      )
      .run(path, messageId, mailbox, isPartial ? 1 : 0, mtimeMs ?? null);
  }

  pathMtime(path: string): number | undefined {
    const r = this.raw.prepare("SELECT mtime_ms FROM message_paths WHERE path=?").get(path) as { mtime_ms: number | null } | undefined;
    return r?.mtime_ms ?? undefined;
  }

  pathsForMessage(messageId: string): { path: string; mailbox: string; isPartial: boolean }[] {
    const rows = this.raw
      .prepare("SELECT path, mailbox, is_partial FROM message_paths WHERE message_id=?")
      .all(messageId) as { path: string; mailbox: string | null; is_partial: number }[];
    return rows.map((r) => ({ path: r.path, mailbox: r.mailbox ?? "", isPartial: !!r.is_partial }));
  }

  allKnownPaths(): Set<string> {
    const rows = this.raw.prepare("SELECT path FROM message_paths").all() as { path: string }[];
    return new Set(rows.map((r) => r.path));
  }

  removePath(path: string): string | undefined {
    const r = this.raw.prepare("SELECT message_id FROM message_paths WHERE path=?").get(path) as { message_id: string } | undefined;
    this.raw.prepare("DELETE FROM message_paths WHERE path=?").run(path);
    return r?.message_id;
  }

  messageHasPath(messageId: string): boolean {
    const r = this.raw.prepare("SELECT 1 FROM message_paths WHERE message_id=? LIMIT 1").get(messageId) as { 1: number } | undefined;
    return r !== undefined;
  }

  allMessageIdsByPath(): Map<string, string> {
    const rows = this.raw.prepare("SELECT message_id, emlx_path FROM messages WHERE emlx_path IS NOT NULL AND deleted=0").all() as { message_id: string; emlx_path: string }[];
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.emlx_path, r.message_id);
    return map;
  }

  getState(key: string): string | undefined {
    const r = this.raw.prepare("SELECT value FROM sync_state WHERE key=?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setState(key: string, value: string): void {
    this.raw.prepare("INSERT INTO sync_state(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  upsertEmbedding(messageId: string, vector: number[], model: string, sourceHash: string): void {
    const r = this.raw.prepare("SELECT rowid FROM messages WHERE message_id=?").get(messageId) as { rowid: number } | undefined;
    if (!r) return;
    const json = JSON.stringify(vector);
    const rid = BigInt(r.rowid);
    this.raw.prepare("DELETE FROM vec_messages WHERE rowid=?").run(rid);
    this.raw.prepare("INSERT INTO vec_messages(rowid, embedding) VALUES (?, ?)").run(rid, json);
    this.raw
      .prepare(`INSERT INTO embed_state(message_id, model, dim, source_hash, embedded_at) VALUES (?,?,?,?,?)
                ON CONFLICT(message_id) DO UPDATE SET model=excluded.model, dim=excluded.dim,
                  source_hash=excluded.source_hash, embedded_at=excluded.embedded_at`)
      .run(messageId, model, vector.length, sourceHash, Math.floor(Date.now() / 1000));
  }

  knn(queryVector: number[], k: number): { messageId: string; distance: number }[] {
    const rows = this.raw
      .prepare(`SELECT m.message_id as messageId, v.distance as distance
                FROM (SELECT rowid, distance FROM vec_messages WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
                JOIN messages m ON m.rowid = v.rowid
                WHERE m.deleted=0`)
      .all(JSON.stringify(queryVector), k) as { messageId: string; distance: number }[];
    return rows;
  }

  embedStateFor(messageId: string): { sourceHash: string; model: string; dim: number } | undefined {
    const r = this.raw.prepare("SELECT source_hash, model, dim FROM embed_state WHERE message_id=?").get(messageId) as
      | { source_hash: string; model: string; dim: number } | undefined;
    return r ? { sourceHash: r.source_hash, model: r.model, dim: r.dim } : undefined;
  }

  messagesNeedingEmbedding(limit: number): MessageRow[] {
    const rows = this.raw
      .prepare(`SELECT m.* FROM messages m LEFT JOIN embed_state e ON e.message_id = m.message_id
                WHERE m.deleted=0 AND (e.message_id IS NULL OR m.updated_at > e.embedded_at)
                ORDER BY m.date DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  embeddedCount(): number {
    return (this.raw.prepare("SELECT COUNT(*) c FROM embed_state").get() as { c: number }).c;
  }

  enableVectors(): boolean {
    if (this.vecLoaded) return true;
    try {
      sqliteVec.load(this.raw);
      this.vecLoaded = true;
      return true;
    } catch {
      this.vecLoaded = false;
      return false;
    }
  }

  ensureVecTable(dim: number): void {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`invalid embedding dimension: ${dim}`);
    const cur = this.getState("vec_dim");
    if (cur && Number(cur) !== dim) {
      // Model/dim changed: existing vectors live in a different space and are
      // incompatible. Drop them and clear embed_state so every message is
      // re-embedded at the new dimension.
      this.raw.exec("DROP TABLE IF EXISTS vec_messages");
      this.raw.exec("DELETE FROM embed_state");
    }
    this.raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(embedding float[${dim}])`);
    if (cur !== String(dim)) this.setState("vec_dim", String(dim));
  }

  upsertAccount(uuid: string, name: string, emails: string[]): void {
    this.raw.prepare(
      `INSERT INTO accounts(uuid, name, emails) VALUES (?,?,?)
       ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, emails=excluded.emails`,
    ).run(uuid, name, emails.join(","));
  }

  hasAccount(uuid: string): boolean {
    return this.raw.prepare("SELECT 1 FROM accounts WHERE uuid=? LIMIT 1").get(uuid) !== undefined;
  }

  /** Resolve a friendly email or account name (case-insensitive substring) to its account UUID. */
  accountByEmailOrName(q: string): string | undefined {
    const needle = `%${q.toLowerCase()}%`;
    const r = this.raw.prepare(
      "SELECT uuid FROM accounts WHERE lower(emails) LIKE ? OR lower(name) LIKE ? LIMIT 1",
    ).get(needle, needle) as { uuid: string } | undefined;
    return r?.uuid;
  }

  upsertMailboxRole(accountUuid: string, mailbox: string, role: string | null): void {
    this.raw.prepare(
      `INSERT INTO mailbox_roles(account_uuid, mailbox_name, role) VALUES (?,?,?)
       ON CONFLICT(account_uuid, mailbox_name) DO UPDATE SET role=excluded.role`,
    ).run(accountUuid, mailbox, role);
  }

  roleForMailbox(accountUuid: string, mailbox: string): string | undefined {
    const r = this.raw.prepare("SELECT role FROM mailbox_roles WHERE account_uuid=? AND mailbox_name=?").get(accountUuid, mailbox) as { role: string | null } | undefined;
    return r?.role ?? undefined;
  }

  mailboxesForRole(accountUuid: string, role: string): string[] {
    return (this.raw.prepare("SELECT mailbox_name FROM mailbox_roles WHERE account_uuid=? AND role=?").all(accountUuid, role) as { mailbox_name: string }[]).map((r) => r.mailbox_name);
  }

  close(): void {
    this.raw.close();
  }
}

function rowToMessage(m: Record<string, unknown>): MessageRow {
  return {
    messageId: m.message_id as string,
    account: m.account as string,
    mailbox: (m.mailbox as string) ?? "",
    fromName: (m.from_name as string) ?? "",
    fromAddr: (m.from_addr as string) ?? "",
    to: JSON.parse((m.to_addrs as string) || "[]"),
    cc: JSON.parse((m.cc_addrs as string) || "[]"),
    subject: (m.subject as string) ?? "",
    date: (m.date as number) ?? 0,
    bodyText: (m.body_text as string) ?? "",
    bodyState: (m.body_state as BodyState) ?? "none",
    source: (m.source as "emlx" | "applescript") ?? "emlx",
    emlxPath: (m.emlx_path as string) ?? null,
    inReplyTo: (m.in_reply_to as string) ?? null,
    references: JSON.parse((m.reference_ids as string) || "[]"),
    gmThrid: (m.gm_thrid as string) ?? null,
    size: (m.size as number) ?? 0,
    toNames: JSON.parse((m.to_names as string) || "[]"),
    ccNames: JSON.parse((m.cc_names as string) || "[]"),
    unread: !!(m.unread as number),
    flagged: !!(m.flagged as number),
    answered: !!(m.answered as number),
    junk: !!(m.junk as number),
    flagColor: (m.flag_color as number) ?? null,
    appleThrid: (m.apple_thrid as number) ?? null,
  };
}
