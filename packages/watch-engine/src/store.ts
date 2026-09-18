import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { DomainEvent, PendingWatchEvent, WatchDefinition, WatchRecord, WatchRule } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  rules TEXT NOT NULL,
  instruction TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  snapshot TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_watches_active ON watches(status, expires_at);
CREATE TABLE IF NOT EXISTS watch_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  watch_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_watch_events_pending ON watch_events(status, created_at);
`;

export class WatchStore {
  private constructor(readonly raw: Database.Database) {}

  static open(path: string): WatchStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return new WatchStore(db);
  }

  create(definition: WatchDefinition, snapshot: unknown, defaultExpiry: number): WatchRecord {
    const now = Date.now();
    const record: WatchRecord = {
      ...definition, id: randomUUID(), status: "active", snapshot,
      expiresAt: definition.expiresAt ?? defaultExpiry, createdAt: now, updatedAt: now,
    };
    this.raw.prepare(`INSERT INTO watches
      (id,source,resource_ref,rules,instruction,chat_id,status,snapshot,expires_at,created_at,updated_at)
      VALUES (@id,@source,@resourceRef,@rules,@instruction,@chatId,@status,@snapshot,@expiresAt,@createdAt,@updatedAt)`)
      .run({ ...record, rules: JSON.stringify(record.rules), snapshot: JSON.stringify(snapshot) });
    return record;
  }

  get(id: string): WatchRecord | null {
    const row = this.raw.prepare("SELECT * FROM watches WHERE id=?").get(id) as WatchRow | undefined;
    return row ? watchFromRow(row) : null;
  }

  stop(id: string): WatchRecord | null {
    this.raw.prepare("UPDATE watches SET status='stopped', updated_at=? WHERE id=? AND status='active'").run(Date.now(), id);
    return this.get(id);
  }

  expireDue(now = Date.now()): WatchRecord[] {
    const due = (this.raw.prepare("SELECT * FROM watches WHERE status='active' AND expires_at<=? ORDER BY created_at").all(now) as WatchRow[])
      .map(watchFromRow);
    if (!due.length) return [];
    this.raw.prepare("UPDATE watches SET status='expired', updated_at=? WHERE status='active' AND expires_at<=?").run(now, now);
    return due.map((watch) => ({ ...watch, status: "expired", updatedAt: now }));
  }

  active(): WatchRecord[] {
    return (this.raw.prepare("SELECT * FROM watches WHERE status='active' ORDER BY created_at").all() as WatchRow[]).map(watchFromRow);
  }

  updateSnapshot(id: string, snapshot: unknown, terminal: boolean): void {
    const now = Date.now();
    this.raw.prepare("UPDATE watches SET snapshot=?, status=?, last_checked_at=?, last_error=NULL, updated_at=? WHERE id=?")
      .run(JSON.stringify(snapshot), terminal ? "completed" : "active", now, now, id);
  }

  updateError(id: string, error: string): void {
    this.raw.prepare("UPDATE watches SET last_checked_at=?, last_error=?, updated_at=? WHERE id=?")
      .run(Date.now(), error.slice(0, 500), Date.now(), id);
  }

  hasRuleFired(watchId: string, ruleId: string): boolean {
    return !!this.raw.prepare("SELECT 1 FROM watch_events WHERE watch_id=? AND rule_id=? LIMIT 1").get(watchId, ruleId);
  }

  enqueue(watch: WatchRecord, rule: WatchRule, event: DomainEvent): boolean {
    const eventKey = `${watch.id}:${rule.id}:${event.key}`;
    const info = this.raw.prepare(`INSERT OR IGNORE INTO watch_events
      (id,event_key,watch_id,rule_id,rule,event,status,attempts,created_at)
      VALUES (?,?,?,?,?,?,'pending',0,?)`)
      .run(randomUUID(), eventKey, watch.id, rule.id, JSON.stringify(rule), JSON.stringify(event), Date.now());
    return info.changes > 0;
  }

  pending(limit = 20): PendingWatchEvent[] {
    const rows = this.raw.prepare(`SELECT e.*, w.chat_id, w.instruction
      FROM watch_events e JOIN watches w ON w.id=e.watch_id
      WHERE e.status='pending' ORDER BY e.created_at LIMIT ?`).all(limit) as EventRow[];
    return rows.map((row) => ({
      id: row.id, watchId: row.watch_id, chatId: row.chat_id, instruction: row.instruction,
      rule: JSON.parse(row.rule) as WatchRule, event: JSON.parse(row.event) as DomainEvent, attempts: row.attempts,
    }));
  }

  delivered(id: string): void {
    this.raw.prepare("UPDATE watch_events SET status='delivered', delivered_at=?, last_error=NULL WHERE id=?").run(Date.now(), id);
  }

  deliveryFailed(id: string, error: string, retry = true): void {
    this.raw.prepare("UPDATE watch_events SET status=?, attempts=attempts+1, last_error=? WHERE id=?")
      .run(retry ? "pending" : "failed", error.slice(0, 500), id);
  }

  close(): void { this.raw.close(); }
}

interface WatchRow {
  id: string; source: string; resource_ref: string; rules: string; instruction: string; chat_id: string;
  status: WatchRecord["status"]; snapshot: string; expires_at: number; created_at: number; updated_at: number;
  last_checked_at: number | null; last_error: string | null;
}
interface EventRow {
  id: string; watch_id: string; rule: string; event: string; attempts: number; chat_id: string; instruction: string;
}
function watchFromRow(row: WatchRow): WatchRecord {
  return {
    id: row.id, source: row.source, resourceRef: row.resource_ref, rules: JSON.parse(row.rules) as WatchRule[],
    instruction: row.instruction, chatId: row.chat_id, status: row.status, snapshot: JSON.parse(row.snapshot),
    expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
