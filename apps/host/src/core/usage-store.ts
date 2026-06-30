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

export interface ToolUsage {
  ts: number;
  sessionId: string;
  tool: string;
  durationMs: number;
  ok: boolean;
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
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT,
  tool TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(ts);
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

  recordTool(t: ToolUsage): void {
    this.raw.prepare(
      `INSERT INTO tool_calls (ts, session_id, tool, duration_ms, ok) VALUES (?, ?, ?, ?, ?)`,
    ).run(t.ts, t.sessionId, t.tool, t.durationMs, t.ok ? 1 : 0);
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
    const byTool = this.raw.prepare(
      `SELECT tool, COUNT(*) calls,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) errors,
              SUM(duration_ms) totalMs, AVG(duration_ms) avgMs, MAX(duration_ms) maxMs
       FROM tool_calls GROUP BY tool ORDER BY calls DESC`,
    ).all();
    const toolTotals = this.raw.prepare(
      `SELECT COUNT(*) calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) errors, COALESCE(SUM(duration_ms),0) totalMs
       FROM tool_calls`,
    ).get();
    return { totals, byDay, byModel, recent, byTool, toolTotals };
  }
}

let singleton: UsageStore | undefined;
export function usageStore(): UsageStore {
  return (singleton ??= UsageStore.open());
}
