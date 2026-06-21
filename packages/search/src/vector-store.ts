import type { Database } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export interface VectorStoreOptions {
  table: string;
  /** State key holding the current dimension; defaults to `<table>_dim`. */
  stateKey?: string;
  getState: (key: string) => string | undefined;
  setState: (key: string, value: string) => void;
  /** Called when a dimension change drops the table, so the caller can clear its embed bookkeeping. */
  onDimReset?: () => void;
}

export class VectorStore {
  private loaded = false;
  private readonly key: string;
  constructor(private readonly raw: Database, private readonly opts: VectorStoreOptions) {
    this.key = opts.stateKey ?? `${opts.table}_dim`;
  }

  enable(): boolean {
    if (this.loaded) return true;
    try { sqliteVec.load(this.raw); this.loaded = true; } catch { this.loaded = false; }
    return this.loaded;
  }

  ensureTable(dim: number): void {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`invalid embedding dimension: ${dim}`);
    const cur = this.opts.getState(this.key);
    if (cur && Number(cur) !== dim) {
      this.raw.exec(`DROP TABLE IF EXISTS ${this.opts.table}`);
      this.opts.onDimReset?.();
    }
    this.raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.opts.table} USING vec0(embedding float[${dim}])`);
    if (cur !== String(dim)) this.opts.setState(this.key, String(dim));
  }

  upsert(rowid: number | bigint, vector: number[]): void {
    const rid = BigInt(rowid);
    const json = JSON.stringify(vector);
    this.raw.prepare(`DELETE FROM ${this.opts.table} WHERE rowid=?`).run(rid);
    this.raw.prepare(`INSERT INTO ${this.opts.table}(rowid, embedding) VALUES (?, ?)`).run(rid, json);
  }

  knn(vector: number[], k: number): { rowid: number; distance: number }[] {
    return this.raw
      .prepare(`SELECT rowid, distance FROM ${this.opts.table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
      .all(JSON.stringify(vector), k) as { rowid: number; distance: number }[];
  }
}
