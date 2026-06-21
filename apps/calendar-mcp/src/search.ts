import { rrf } from "@llm-wiki/search";
import type { EventFilter, IndexDb } from "./index-db.ts";

/**
 * Candidate pool fetched from each ranker before filtering + fusion. Larger than
 * any caller's `limit` so account/calendar/date filters narrow a ranked pool
 * rather than an already-truncated top-N (which would under-return).
 */
const CANDIDATE_POOL = 500;

/** Escape a free-text query so it is safe as an FTS5 MATCH parameter (quote each token). */
function ftsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export interface SearchDeps {
  index: IndexDb;
  embedQuery?: (text: string) => Promise<number[] | null>;
}

export async function hybridSearch(deps: SearchDeps, query: string, limit: number, filter?: EventFilter): Promise<string[]> {
  const fts = ftsQuery(query);
  // FTS pre-filters in SQL; the vector side post-filters against the same allowed set.
  const ftsIds = fts ? deps.index.ftsSearch(fts, CANDIDATE_POOL, filter) : [];
  const allowed = filter ? deps.index.allowedUids(filter) : null;

  let vecIds: string[] = [];
  if (deps.embedQuery) {
    const qv = await deps.embedQuery(query);
    const dim = Number(deps.index.getState("vec_events_dim") ?? 0);
    if (qv && qv.length === dim && dim > 0) {
      deps.index.vectors.enable();
      const hits = deps.index.vectors.knn(qv, CANDIDATE_POOL);
      vecIds = hits
        .map((h) => deps.index.rowidToUid(h.rowid))
        .filter((u): u is string => !!u && (!allowed || allowed.has(u)));
    }
  }

  const ordered = vecIds.length ? rrf([ftsIds, vecIds]).map((r) => r.id) : ftsIds;
  return ordered.slice(0, limit);
}
