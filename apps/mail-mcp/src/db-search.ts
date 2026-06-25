import type { Store } from "../../mail-mirror/src/store.ts";
import type { MessageSummary } from "./types.ts";
import { mailUrl } from "./mail-url.ts";
import { buildFilterSql, type DbFilters } from "./filters.ts";
import { rrf } from "./rrf.ts";
import { resolveScope } from "./scope.ts";

export interface SearchDbArgs extends DbFilters {
  query?: string;
  limit?: number;
  offset?: number;
  perMessage?: boolean;
  sort?: "date" | "size";
  sortDir?: "asc" | "desc";
  fromName?: string;
  fromAddr?: string;
  toName?: string;
  subjectContains?: string;
  bodyContains?: string;
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
  const scope = resolveScope(store, { account: args.account, mailbox: args.mailbox, anyMailbox: args.anyMailbox });
  const filters: DbFilters = { ...args, account: scope.account, mailbox: undefined, mailboxNames: scope.mailboxNames, anyMailbox: scope.anyMailbox };
  const { clause, params } = buildFilterSql(filters);

  // Field-scoped trigram substring params (AND across params), computed up front so
  // they can DRIVE candidate selection — not merely filter a recency-limited window.
  const TRIG: [keyof SearchDbArgs, string][] = [
    ["fromName", "from_name"], ["fromAddr", "from_addr"], ["toName", "to_names"],
    ["subjectContains", "subject"], ["bodyContains", "body_text"],
  ];
  const trigParams = TRIG.filter(([k]) => typeof args[k] === "string" && (args[k] as string).length);
  let trigAllowed: Set<string> | null = null;
  if (trigParams.length) {
    for (const [k, field] of trigParams) {
      const ids = new Set(store.searchTrig(field, args[k] as string, 500).map((m) => m.messageId));
      trigAllowed = trigAllowed === null ? ids : new Set(([...trigAllowed] as string[]).filter((id) => ids.has(id)));
    }
    trigAllowed = trigAllowed ?? new Set<string>();
  }

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
    // Free-text ranking present: trigram params narrow the ranked results.
    if (trigAllowed) orderedIds = orderedIds.filter((id) => trigAllowed!.has(id));
  } else {
    const col = args.sort === "size" ? "m.size" : "m.date";
    const dir = args.sortDir === "asc" ? "ASC" : "DESC";
    // No ranking to bound the pool: browse a wider window so filters/trigram
    // (and a high offset/limit) can reach beyond the most-recent handful.
    const BROWSE = 500;
    if (trigAllowed) {
      const ids = [...trigAllowed];
      if (!ids.length) {
        orderedIds = [];
      } else {
        const ph = ids.map(() => "?").join(",");
        orderedIds = store.raw
          .prepare(`SELECT m.message_id FROM messages m WHERE ${clause} AND m.message_id IN (${ph}) ORDER BY ${col} ${dir} LIMIT ${BROWSE}`)
          .all(...params, ...ids)
          .map((r) => (r as { message_id: string }).message_id);
      }
    } else {
      orderedIds = store.raw
        .prepare(`SELECT m.message_id FROM messages m WHERE ${clause} ORDER BY ${col} ${dir} LIMIT ${BROWSE}`)
        .all(...params)
        .map((r) => (r as { message_id: string }).message_id);
    }
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
      mailUrl: mailUrl(m.message_id),
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
