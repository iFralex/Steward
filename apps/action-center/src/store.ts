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
    const existing = this.raw.prepare("SELECT id, status FROM actions WHERE source_key=?").get(input.sourceKey) as
      | { id: number; status: ActionStatus }
      | undefined;
    const payload = JSON.stringify(input.payload ?? {});

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
    // changes (e.g. a newer message id).
    if (existing.status === "done" || existing.status === "dismissed") {
      return { id: existing.id, inserted: false, updated: false };
    }

    this.raw.prepare(
      `UPDATE actions
       SET source_kind=@source_kind, kind=@kind, priority=@priority, title=@title,
           summary=@summary, due_at=@due_at, payload=@payload, updated_at=@now
       WHERE id=@id`,
    ).run({
      id: existing.id,
      source_kind: input.sourceKind,
      kind: input.kind,
      priority: input.priority ?? "normal",
      title: input.title,
      summary: input.summary,
      due_at: input.dueAt ?? null,
      payload,
      now,
    });
    return { id: existing.id, inserted: false, updated: true };
  }

  mark(id: number, status: ActionStatus): boolean {
    const info = this.raw.prepare("UPDATE actions SET status=?, updated_at=? WHERE id=?")
      .run(status, Math.floor(Date.now() / 1000), id);
    return info.changes > 0;
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

  close(): void { this.raw.close(); }
}

function rowToAction(r: Record<string, unknown>): ActionItem {
  let payload: Record<string, unknown> = {};
  try {
    const p = JSON.parse(String(r.payload ?? "{}"));
    if (p && typeof p === "object" && !Array.isArray(p)) payload = p as Record<string, unknown>;
  } catch { /* keep empty */ }
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
