import Database from "better-sqlite3";

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

  get(messageId: string): { decision: string; sourceHash: string } | undefined {
    const r = this.db.prepare("SELECT decision, source_hash FROM promote_state WHERE message_id=?").get(messageId) as { decision: string; source_hash: string } | undefined;
    return r ? { decision: r.decision, sourceHash: r.source_hash } : undefined;
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
