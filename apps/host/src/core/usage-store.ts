/**
 * Persistent per-turn usage ledger (SQLite). Each agent turn records its token
 * deltas + cost so the Usage page can show granular, history-spanning stats
 * (survives host restarts, unlike Pi's in-memory session stats).
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TurnUsage {
  ts: number;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
`;

export class UsageStore {
  readonly raw: Database.Database;
  constructor(db: Database.Database) {
    this.raw = db;
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(SCHEMA);
  }

  static open(): UsageStore {
    const dir = process.env.USAGE_DIR ?? join(homedir(), "Library", "Application Support", "llmwiki-usage");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new UsageStore(new Database(join(dir, "usage.db")));
  }

  record(t: TurnUsage): void {
    this.raw.prepare(
      `INSERT INTO turns (ts, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.ts, t.sessionId, t.model, t.inputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens, t.costUsd);
  }

  summary(): unknown {
    const totals = this.raw.prepare(
      `SELECT COUNT(*) turns, COALESCE(SUM(cost_usd),0) cost,
              COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
              COALESCE(SUM(cache_read_tokens),0) cacheRead, COALESCE(SUM(cache_write_tokens),0) cacheWrite
       FROM turns`,
    ).get();
    const byDay = this.raw.prepare(
      `SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') day,
              SUM(cost_usd) cost,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) tokens,
              COUNT(*) turns
       FROM turns GROUP BY day ORDER BY day DESC LIMIT 30`,
    ).all();
    const byModel = this.raw.prepare(
      `SELECT model, SUM(cost_usd) cost,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) tokens, COUNT(*) turns
       FROM turns GROUP BY model ORDER BY cost DESC`,
    ).all();
    const recent = this.raw.prepare(
      `SELECT ts, model, input_tokens input, output_tokens output,
              cache_read_tokens cacheRead, cache_write_tokens cacheWrite, cost_usd cost
       FROM turns ORDER BY ts DESC LIMIT 100`,
    ).all();
    return { totals, byDay, byModel, recent };
  }
}

let singleton: UsageStore | undefined;
export function usageStore(): UsageStore {
  return (singleton ??= UsageStore.open());
}
