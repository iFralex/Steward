import { rrf } from "@llm-wiki/search";
import type { IndexDb } from "./index-db.ts";

const CANDIDATE_POOL = 200;

/** Tokenize to alphanumeric (unicode) tokens, quote each, OR-join — safe for FTS5 MATCH. */
function ftsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export interface SearchDeps {
  index: IndexDb;
  embedQuery?: (text: string) => Promise<number[] | null>;
}

export async function hybridSearch(deps: SearchDeps, query: string, limit: number): Promise<string[]> {
  const fts = ftsQuery(query);
  const ftsIds = fts ? deps.index.ftsSearch(fts, CANDIDATE_POOL) : [];

  let vecIds: string[] = [];
  if (deps.embedQuery) {
    const qv = await deps.embedQuery(query);
    const dim = Number(deps.index.getState("vec_contacts_dim") ?? 0);
    if (qv && qv.length === dim && dim > 0) {
      deps.index.vectors.enable();
      const hits = deps.index.vectors.knn(qv, CANDIDATE_POOL);
      vecIds = hits.map((h) => deps.index.rowidToUid(h.rowid)).filter((u): u is string => !!u);
    }
  }

  const ordered = vecIds.length ? rrf([ftsIds, vecIds]).map((r) => r.id) : ftsIds;
  return ordered.slice(0, limit);
}
