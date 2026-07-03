import Database from "better-sqlite3";
import type { ActionItem, ActionStatus, UpsertAction } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  due_at INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_status_due ON actions(status, due_at);
CREATE INDEX IF NOT EXISTS idx_actions_kind ON actions(kind);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_messages (
  message_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_at ON seen_messages(seen_at);
`;

export class ActionStore {
  private constructor(readonly raw: Database.Database) {}

  static open(path: string): ActionStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return new ActionStore(db);
  }

  upsert(input: UpsertAction): { id: number; inserted: boolean; updated: boolean } {
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify(input.payload ?? {});
    const existing = this.findExisting(input);

    if (!existing) {
      const info = this.raw.prepare(
        `INSERT INTO actions(source_key,source_kind,kind,status,priority,title,summary,due_at,payload,created_at,updated_at)
         VALUES (@source_key,@source_kind,@kind,'new',@priority,@title,@summary,@due_at,@payload,@now,@now)`,
      ).run({
        source_key: input.sourceKey,
        source_kind: input.sourceKind,
        kind: input.kind,
        priority: input.priority ?? "normal",
        title: input.title,
        summary: input.summary,
        due_at: input.dueAt ?? null,
        payload,
        now,
      });
      return { id: Number(info.lastInsertRowid), inserted: true, updated: false };
    }

    // Completed/dismissed actions are intentionally sticky: future scans should
    // not resurrect something the user already handled unless its source key
    // changes (e.g. a newer message id). For mail threads, however, a newer
    // message in the same thread is a new user-visible event, so reopen it.
    if (existing.status === "done" || existing.status === "dismissed") {
      if (!shouldReopenHandledMail(existing.payload, input.payload)) {
        return { id: existing.id, inserted: false, updated: false };
      }
    }

    this.raw.prepare(
      `UPDATE actions
       SET source_key=@source_key, source_kind=@source_kind, kind=@kind,
           status=@status, priority=@priority, title=@title,
           summary=@summary, due_at=@due_at, payload=@payload, updated_at=@now
       WHERE id=@id`,
    ).run({
      id: existing.id,
      source_key: input.sourceKey,
      source_kind: input.sourceKind,
      kind: input.kind,
      status: existing.status === "done" || existing.status === "dismissed" ? "new" : existing.status,
      priority: input.priority ?? "normal",
      title: input.title,
      summary: input.summary,
      due_at: input.dueAt ?? null,
      payload,
      now,
    });
    return { id: existing.id, inserted: false, updated: true };
  }

  private findExisting(input: UpsertAction): { id: number; status: ActionStatus; payload: Record<string, unknown> } | undefined {
    const byKey = this.raw.prepare("SELECT id, status, payload FROM actions WHERE source_key=?").get(input.sourceKey) as
      | { id: number; status: ActionStatus; payload: string }
      | undefined;
    if (byKey) return { ...byKey, payload: parsePayload(byKey.payload) };

    const threadId = input.sourceKind === "mail" ? input.payload?.threadId : null;
    if (typeof threadId !== "number" || !Number.isFinite(threadId)) return undefined;

    // Migration bridge for older rows keyed by message id: if they already
    // represent the same thread, update that row instead of creating a duplicate.
    const byThread = this.raw.prepare(
      `SELECT id, status, payload FROM actions
       WHERE source_kind='mail'
         AND json_extract(payload, '$.threadId') = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(threadId) as { id: number; status: ActionStatus; payload: string } | undefined;
    return byThread ? { ...byThread, payload: parsePayload(byThread.payload) } : undefined;
  }

  mark(id: number, status: ActionStatus): boolean {
    const info = this.raw.prepare("UPDATE actions SET status=?, updated_at=? WHERE id=?")
      .run(status, Math.floor(Date.now() / 1000), id);
    return info.changes > 0;
  }

  get(id: number): ActionItem | null {
    const row = this.raw.prepare("SELECT * FROM actions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToAction(row) : null;
  }

  list(opts: { includeDone?: boolean; limit?: number } = {}): ActionItem[] {
    const includeDone = opts.includeDone ?? false;
    const limit = opts.limit ?? 50;
    const rows = this.raw.prepare(
      `SELECT * FROM actions
       ${includeDone ? "" : "WHERE status IN ('new','read')"}
       ORDER BY COALESCE(due_at, 9223372036854775807), priority DESC, updated_at DESC
       LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    return rows.map(rowToAction);
  }

  counts(): Record<ActionStatus, number> {
    const rows = this.raw.prepare("SELECT status, count(*) AS cnt FROM actions GROUP BY status").all() as
      { status: ActionStatus; cnt: number }[];
    return { new: 0, read: 0, done: 0, dismissed: 0, ...Object.fromEntries(rows.map((r) => [r.status, r.cnt])) };
  }

  setMeta(key: string, value: unknown): void {
    this.raw.prepare(
      `INSERT INTO meta(key,value,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(key, JSON.stringify(value), Math.floor(Date.now() / 1000));
  }

  getMeta<T = unknown>(key: string): T | null {
    const row = this.raw.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  // --- "already evaluated" ledger: mail we've run the planner on, so scans work
  //     only on genuinely new mail (or new replies) instead of re-evaluating. ---

  /** Message ids already evaluated (optionally only those seen at/after `sinceTs`). */
  loadSeen(sinceTs?: number): Set<string> {
    const rows = (typeof sinceTs === "number"
      ? this.raw.prepare("SELECT message_id FROM seen_messages WHERE seen_at >= ?").all(sinceTs)
      : this.raw.prepare("SELECT message_id FROM seen_messages").all()) as { message_id: string }[];
    return new Set(rows.map((r) => r.message_id));
  }

  markSeen(messageIds: string[], seenAt = Math.floor(Date.now() / 1000)): void {
    if (messageIds.length === 0) return;
    const stmt = this.raw.prepare("INSERT OR IGNORE INTO seen_messages(message_id, seen_at) VALUES (?, ?)");
    const tx = this.raw.transaction((ids: string[]) => { for (const id of ids) if (id) stmt.run(id, seenAt); });
    tx(messageIds);
  }

  hasAnySeen(): boolean {
    return !!this.raw.prepare("SELECT 1 FROM seen_messages LIMIT 1").get();
  }

  /** Drop old ledger rows (outside the scan window) to keep the table bounded. */
  pruneSeen(beforeTs: number): void {
    this.raw.prepare("DELETE FROM seen_messages WHERE seen_at < ?").run(beforeTs);
  }

  close(): void { this.raw.close(); }
}

function rowToAction(r: Record<string, unknown>): ActionItem {
  const payload = parsePayload(r.payload);
  return {
    id: Number(r.id),
    sourceKey: String(r.source_key),
    sourceKind: r.source_kind as ActionItem["sourceKind"],
    kind: r.kind as ActionItem["kind"],
    status: r.status as ActionItem["status"],
    priority: r.priority as ActionItem["priority"],
    title: String(r.title ?? ""),
    summary: String(r.summary ?? ""),
    dueAt: r.due_at == null ? null : Number(r.due_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    payload,
  };
}

function parsePayload(value: unknown): Record<string, unknown> {
  try {
    const p = JSON.parse(String(value ?? "{}"));
    if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch { /* keep empty */ }
  return {};
}

function shouldReopenHandledMail(existingPayload: Record<string, unknown>, incomingPayload: Record<string, unknown> | undefined): boolean {
  if (!incomingPayload) return false;
  const existingThread = existingPayload.threadId;
  const incomingThread = incomingPayload.threadId;
  if (typeof existingThread !== "number" || existingThread !== incomingThread) return false;
  const existingDate = typeof existingPayload.date === "number" ? existingPayload.date : 0;
  const incomingDate = typeof incomingPayload.date === "number" ? incomingPayload.date : 0;
  const existingMessage = typeof existingPayload.messageId === "string" ? existingPayload.messageId : "";
  const incomingMessage = typeof incomingPayload.messageId === "string" ? incomingPayload.messageId : "";
  return incomingDate > existingDate && incomingMessage !== existingMessage;
}
