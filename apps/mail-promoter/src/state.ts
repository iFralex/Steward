import Database from "better-sqlite3";
import type { GateDecision } from "./gte.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS promote_state (
  message_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  categories TEXT,
  classify_model TEXT,
  distill_model TEXT,
  wiki_filename TEXT,
  source_hash TEXT,
  promoted_at INTEGER
);
CREATE TABLE IF NOT EXISTS mail_gate_cache (
  thread_id INTEGER PRIMARY KEY,
  cache_key TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  evaluated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_runtime (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);`;

export interface PromoteRecord {
  messageId: string;
  decision: "promoted" | "skipped" | "filtered";
  categories: string[];
  classifyModel: string;
  distillModel: string | null;
  wikiFilename: string | null;
  sourceHash: string;
}

export interface StoredPromoteRecord {
  messageId: string;
  decision: PromoteRecord["decision"];
  categories: string[];
  classifyModel: string;
  distillModel: string | null;
  wikiFilename: string | null;
  sourceHash: string;
  promotedAt: number;
}

export class PromoteState {
  private constructor(private db: Database.Database) {}

  static open(path: string): PromoteState {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return new PromoteState(db);
  }

  needsProcessing(messageId: string, sourceHash: string): boolean {
    const r = this.db.prepare("SELECT source_hash FROM promote_state WHERE message_id=?").get(messageId) as { source_hash: string } | undefined;
    return !r || r.source_hash !== sourceHash;
  }

  gateDecision(threadId: number, cacheKey: string): GateDecision | undefined {
    const row = this.db.prepare("SELECT decision_json FROM mail_gate_cache WHERE thread_id=? AND cache_key=?").get(threadId, cacheKey) as { decision_json: string } | undefined;
    try {
      const value = row ? JSON.parse(row.decision_json) : undefined;
      if (value?.route === "llm" && value.reason === "context_overflow" && Number.isInteger(value.tokens) && value.tokens > 8192) return value;
      if (value?.reason === "scored" && ["discard", "llm"].includes(value.route)
        && Number.isFinite(value.score) && value.score >= 0 && value.score <= 1
        && Number.isFinite(value.threshold) && value.threshold > 0 && value.threshold < 1
        && Number.isInteger(value.tokens) && value.tokens >= 1 && value.tokens <= 8192
        && (value.route === "discard") === (value.score < value.threshold)) return value;
    } catch { /* invalid cache must not discard a mail */ }
    return undefined;
  }

  recordGate(threadId: number, cacheKey: string, decision: GateDecision): void {
    this.db.prepare(`INSERT INTO mail_gate_cache(thread_id,cache_key,decision_json,evaluated_at) VALUES(?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET cache_key=excluded.cache_key,decision_json=excluded.decision_json,evaluated_at=excluded.evaluated_at`)
      .run(threadId, cacheKey, JSON.stringify(decision), Math.floor(Date.now()/1000));
  }

  runtime<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM mail_runtime WHERE key=?").get(key) as { value_json: string } | undefined;
    try { return row ? JSON.parse(row.value_json) as T : undefined; } catch { return undefined; }
  }

  setRuntime(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO mail_runtime(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
      .run(key, JSON.stringify(value));
  }

  gateCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT json_extract(decision_json,'$.route') route,count(*) count FROM mail_gate_cache WHERE json_valid(decision_json) GROUP BY 1")
      .all() as { route: string; count: number }[];
    return Object.fromEntries(rows.map(r => [r.route, r.count]));
  }

  get(messageId: string): { decision: string; sourceHash: string } | undefined {
    const r = this.db.prepare("SELECT decision, source_hash FROM promote_state WHERE message_id=?").get(messageId) as { decision: string; source_hash: string } | undefined;
    return r ? { decision: r.decision, sourceHash: r.source_hash } : undefined;
  }

  getRecord(messageId: string): StoredPromoteRecord | undefined {
    const r = this.db.prepare(
      `SELECT message_id, decision, categories, classify_model, distill_model,
              wiki_filename, source_hash, promoted_at
       FROM promote_state WHERE message_id=?`,
    ).get(messageId) as {
      message_id: string; decision: PromoteRecord["decision"]; categories: string | null;
      classify_model: string | null; distill_model: string | null; wiki_filename: string | null;
      source_hash: string; promoted_at: number | null;
    } | undefined;
    if (!r) return undefined;
    let categories: string[] = [];
    try {
      const parsed = JSON.parse(r.categories ?? "[]");
      if (Array.isArray(parsed)) categories = parsed.filter((v): v is string => typeof v === "string");
    } catch { /* keep empty */ }
    return {
      messageId: r.message_id,
      decision: r.decision,
      categories,
      classifyModel: r.classify_model ?? "",
      distillModel: r.distill_model,
      wikiFilename: r.wiki_filename,
      sourceHash: r.source_hash,
      promotedAt: r.promoted_at ?? 0,
    };
  }

  promotedThreadRecords(): StoredPromoteRecord[] {
    const ids = this.db.prepare(
      `SELECT message_id FROM promote_state
       WHERE decision='promoted' AND message_id LIKE 'thread:%'
       ORDER BY CAST(substr(message_id, 8) AS INTEGER)`,
    ).all() as { message_id: string }[];
    return ids.map((r) => this.getRecord(r.message_id)).filter((r): r is StoredPromoteRecord => !!r);
  }

  updateWikiFilename(messageId: string, filename: string): void {
    this.db.prepare("UPDATE promote_state SET wiki_filename=? WHERE message_id=?").run(filename, messageId);
  }

  record(r: PromoteRecord): void {
    this.db.prepare(
      `INSERT INTO promote_state (message_id, decision, categories, classify_model, distill_model, wiki_filename, source_hash, promoted_at)
       VALUES (@message_id,@decision,@categories,@classify_model,@distill_model,@wiki_filename,@source_hash,@now)
       ON CONFLICT(message_id) DO UPDATE SET decision=excluded.decision, categories=excluded.categories,
         classify_model=excluded.classify_model, distill_model=excluded.distill_model,
         wiki_filename=excluded.wiki_filename, source_hash=excluded.source_hash, promoted_at=excluded.promoted_at`,
    ).run({
      message_id: r.messageId, decision: r.decision, categories: JSON.stringify(r.categories),
      classify_model: r.classifyModel, distill_model: r.distillModel, wiki_filename: r.wikiFilename,
      source_hash: r.sourceHash, now: Math.floor(Date.now() / 1000),
    });
  }

  counts(): { promoted: number; skipped: number } {
    const rows = this.db.prepare("SELECT decision, COUNT(*) as cnt FROM promote_state GROUP BY decision").all() as { decision: string; cnt: number }[];
    const map = Object.fromEntries(rows.map((r) => [r.decision, r.cnt]));
    return { promoted: map["promoted"] ?? 0, skipped: map["skipped"] ?? 0 };
  }

  close(): void { this.db.close(); }
}
