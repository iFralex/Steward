import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type WriteOpStatus =
  | "scheduled"
  | "started"
  | "script_returned"
  | "confirmed"
  | "unknown"
  | "failed"
  | "restart_prepared"
  | "retrying"
  | "retry_exhausted";

export type WriteOpKind =
  | "mail.send"
  | "mail.reply"
  | "calendar.create"
  | "calendar.update"
  | "calendar.delete";

export interface WriteOpInput {
  kind: WriteOpKind;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface WriteOpRow extends WriteOpInput {
  id: string;
  status: WriteOpStatus;
  attempts: number;
  confirmAttempts: number;
  startedAt: number;
  updatedAt: number;
  scriptFinishedAt: number | null;
  confirmedAt: number | null;
  /** For status "scheduled": unix seconds at/after which the op should be sent. */
  scheduledFor: number | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS write_ops (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  confirm_attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  script_finished_at INTEGER,
  confirmed_at INTEGER,
  scheduled_for INTEGER,
  input_json TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  result_json TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_write_ops_status ON write_ops(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_write_ops_kind_started ON write_ops(kind, started_at);
`;

export function writeOpsDir(): string {
  const dir = process.env.WRITE_OPS_DIR ?? join(homedir(), "Library", "Application Support", "write-ops");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writeOpsDbPath(): string {
  return join(writeOpsDir(), "ops.db");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function bodySnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

export class WriteOpsStore {
  readonly raw: Database.Database;

  constructor(db: Database.Database) {
    this.raw = db;
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(SCHEMA);
    // Migrate older DBs that predate scheduled sends (add the column BEFORE its
    // index — an old table lacks the column, so the index can't be in SCHEMA).
    const cols = new Set((this.raw.prepare("PRAGMA table_info(write_ops)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("scheduled_for")) this.raw.exec("ALTER TABLE write_ops ADD COLUMN scheduled_for INTEGER");
    this.raw.exec("CREATE INDEX IF NOT EXISTS idx_write_ops_scheduled ON write_ops(status, scheduled_for)");
  }

  static open(path = writeOpsDbPath()): WriteOpsStore {
    return new WriteOpsStore(new Database(path));
  }

  close(): void {
    this.raw.close();
  }

  start(op: WriteOpInput): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare(
      `INSERT INTO write_ops
       (id, kind, status, attempts, confirm_attempts, started_at, updated_at, input_json, expected_json)
       VALUES (?, ?, 'started', 1, 0, ?, ?, ?, ?)`,
    ).run(id, op.kind, now, now, JSON.stringify(op.input), JSON.stringify(op.expected));
    return id;
  }

  /** Enqueue a deferred send/reply to fire at `scheduledFor` (unix seconds). */
  startScheduled(op: WriteOpInput, scheduledFor: number): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare(
      `INSERT INTO write_ops
       (id, kind, status, attempts, confirm_attempts, started_at, updated_at, scheduled_for, input_json, expected_json)
       VALUES (?, ?, 'scheduled', 0, 0, ?, ?, ?, ?, ?)`,
    ).run(id, op.kind, now, now, scheduledFor, JSON.stringify(op.input), JSON.stringify(op.expected));
    return id;
  }

  /** Scheduled ops whose time has come (status 'scheduled' and due). */
  dueScheduled(now: number, limit = 50): WriteOpRow[] {
    const rows = this.raw.prepare(
      "SELECT * FROM write_ops WHERE status='scheduled' AND scheduled_for <= ? ORDER BY scheduled_for ASC LIMIT ?",
    ).all(now, limit) as Record<string, unknown>[];
    return rows.map(rowToWriteOp);
  }

  /** All still-pending scheduled ops (for listing). */
  listScheduled(limit = 100): WriteOpRow[] {
    const rows = this.raw.prepare(
      "SELECT * FROM write_ops WHERE status='scheduled' ORDER BY scheduled_for ASC LIMIT ?",
    ).all(limit) as Record<string, unknown>[];
    return rows.map(rowToWriteOp);
  }

  /** Cancel a still-pending scheduled op. Returns false if it isn't scheduled (e.g. already fired). */
  cancelScheduled(id: string): boolean {
    return this.raw.prepare("DELETE FROM write_ops WHERE id=? AND status='scheduled'").run(id).changes > 0;
  }

  scriptReturned(id: string, result: Record<string, unknown> = {}): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare(
      `UPDATE write_ops
       SET status='script_returned', script_finished_at=?, updated_at=?, result_json=?, last_error=NULL
       WHERE id=?`,
    ).run(now, now, JSON.stringify(result), id);
  }

  failed(id: string, err: unknown): void {
    const now = Math.floor(Date.now() / 1000);
    const message = err instanceof Error ? err.message : String(err);
    const status: WriteOpStatus = /timed out|timeout|-1712|connection is invalid|-609/i.test(message) ? "unknown" : "failed";
    this.raw.prepare(
      `UPDATE write_ops
       SET status=?, script_finished_at=?, updated_at=?, last_error=?
       WHERE id=?`,
    ).run(status, now, now, message, id);
  }

  markConfirmed(id: string, result: Record<string, unknown> = {}): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare(
      `UPDATE write_ops
       SET status='confirmed', confirmed_at=?, updated_at=?, result_json=?
       WHERE id=?`,
    ).run(now, now, JSON.stringify(result), id);
  }

  incrementConfirmAttempt(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare("UPDATE write_ops SET confirm_attempts=confirm_attempts+1, updated_at=? WHERE id=?").run(now, id);
  }

  markRetrying(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare("UPDATE write_ops SET status='retrying', attempts=attempts+1, updated_at=? WHERE id=?").run(now, id);
  }

  markRestartPrepared(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare("UPDATE write_ops SET status='restart_prepared', updated_at=? WHERE id=?").run(now, id);
  }

  markRetryExhausted(id: string, error: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare("UPDATE write_ops SET status='retry_exhausted', updated_at=?, last_error=? WHERE id=?").run(now, error, id);
  }

  pendingForConfirmation(kinds: WriteOpKind[], limit = 100): WriteOpRow[] {
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.raw.prepare(
      `SELECT * FROM write_ops
       WHERE kind IN (${placeholders})
         AND status IN ('script_returned','unknown','failed','restart_prepared','retrying')
       ORDER BY started_at ASC
       LIMIT ?`,
    ).all(...kinds, limit) as Record<string, unknown>[];
    return rows.map(rowToWriteOp);
  }
}

function rowToWriteOp(row: Record<string, unknown>): WriteOpRow {
  return {
    id: row.id as string,
    kind: row.kind as WriteOpKind,
    status: row.status as WriteOpStatus,
    attempts: Number(row.attempts ?? 0),
    confirmAttempts: Number(row.confirm_attempts ?? 0),
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
    scriptFinishedAt: row.script_finished_at == null ? null : Number(row.script_finished_at),
    confirmedAt: row.confirmed_at == null ? null : Number(row.confirmed_at),
    scheduledFor: row.scheduled_for == null ? null : Number(row.scheduled_for),
    input: JSON.parse((row.input_json as string) || "{}"),
    expected: JSON.parse((row.expected_json as string) || "{}"),
    result: row.result_json == null ? null : JSON.parse(row.result_json as string),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}
