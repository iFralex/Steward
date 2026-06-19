import type { Store } from "../../mail-mirror/src/store.ts";
import type { MessageSummary } from "./types.ts";
import { buildFilterSql, type DbFilters } from "./filters.ts";
import { rrf } from "./rrf.ts";

export interface SearchDbArgs extends DbFilters {
  query?: string;
  limit?: number;
  offset?: number;
  perMessage?: boolean;
}

const CANDIDATES = 50;

/** Escape a free-text query so it is safe to pass as an FTS5 MATCH parameter. */
function ftsQuery(q: string): string {
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export async function searchDb(
  store: Store,
  args: SearchDbArgs,
  embedQuery?: (text: string) => Promise<number[] | null>,
): Promise<MessageSummary[]> {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const offset = Math.max(args.offset ?? 0, 0);
  const { clause, params } = buildFilterSql(args);

  let orderedIds: string[];
  if (args.query) {
    let ftsIds: string[];
    try {
      ftsIds = store.raw
        .prepare(`SELECT m.message_id FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
                  WHERE messages_fts MATCH ? AND ${clause} ORDER BY rank LIMIT ${CANDIDATES}`)
        .all(ftsQuery(args.query), ...params)
        .map((r) => (r as { message_id: string }).message_id);
    } catch {
      ftsIds = [];
    }

    let vecIds: string[] = [];
    if (embedQuery) {
      const qv = await embedQuery(args.query);
      const vecDim = Number(store.getState("vec_dim") ?? 0);
      if (qv && qv.length === vecDim) {
        const hits = store.knn(qv, CANDIDATES).map((h) => h.messageId);
        if (hits.length) {
          // keep only those passing the filters, preserving knn order
          const placeholders = hits.map(() => "?").join(",");
          const allowed = new Set(
            store.raw
              .prepare(`SELECT m.message_id FROM messages m WHERE ${clause} AND m.message_id IN (${placeholders})`)
              .all(...params, ...hits)
              .map((r) => (r as { message_id: string }).message_id),
          );
          vecIds = hits.filter((id) => allowed.has(id));
        }
      }
    }
    orderedIds = vecIds.length ? rrf([ftsIds, vecIds]).map((r) => r.id) : ftsIds;
  } else {
    orderedIds = store.raw
      .prepare(`SELECT m.message_id FROM messages m WHERE ${clause} ORDER BY m.date DESC LIMIT ${CANDIDATES}`)
      .all(...params)
      .map((r) => (r as { message_id: string }).message_id);
  }

  // Load summaries in ranked order; group by thread (best-ranked wins) unless perMessage.
  const seenThreads = new Set<number>();
  const grouped: MessageSummary[] = [];
  for (const id of orderedIds) {
    const m = store.raw
      .prepare(`SELECT message_id, subject, from_addr, from_name, date, mailbox, account, snippet, thread_id
                FROM messages WHERE message_id=?`)
      .get(id) as
      | { message_id: string; subject: string; from_addr: string; from_name: string; date: number; mailbox: string; account: string; snippet: string; thread_id: number | null }
      | undefined;
    if (!m) continue;
    if (!args.perMessage && m.thread_id != null) {
      if (seenThreads.has(m.thread_id)) continue;
      seenThreads.add(m.thread_id);
    }
    grouped.push({
      id,
      messageId: m.message_id,
      subject: m.subject ?? "",
      from: m.from_name ? `${m.from_name} <${m.from_addr}>` : (m.from_addr ?? ""),
      date: new Date(m.date * 1000).toISOString(),
      mailbox: m.mailbox ?? "",
      account: m.account ?? "",
      snippet: m.snippet ?? "",
      threadId: m.thread_id ?? undefined,
    });
  }
  return grouped.slice(offset, offset + limit);
}
