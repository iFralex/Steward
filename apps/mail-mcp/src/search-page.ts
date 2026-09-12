import type { MessageSummary, SearchArgs } from "./types.ts";

export const DEFAULT_SEARCH_PAGE_SIZE = 8;
export const MAX_SEARCH_PAGE_SIZE = 12;

export interface CompactMessageSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  mailbox: string;
  account: string;
  snippet: string;
  threadId?: number;
  mailUrl: string;
}

export interface MessageSearchPage {
  messages: CompactMessageSummary[];
  page: {
    offset: number;
    returned: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

export function normalizeSearchPage(args: SearchArgs): { limit: number; offset: number; fetchArgs: SearchArgs } {
  const limit = Math.min(Math.max(Math.floor(args.limit ?? DEFAULT_SEARCH_PAGE_SIZE), 1), MAX_SEARCH_PAGE_SIZE);
  const offset = Math.max(Math.floor(args.offset ?? 0), 0);
  return { limit, offset, fetchArgs: { ...args, limit: limit + 1, offset } };
}

export function buildSearchPage(rows: MessageSummary[], limit: number, offset: number): MessageSearchPage {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return {
    messages: visible.map((row, index) => ({
      id: row.id,
      subject: row.subject,
      from: row.from,
      date: row.date,
      mailbox: row.mailbox,
      account: row.account,
      snippet: truncate(row.snippet, index < 3 ? 200 : 120),
      ...(row.threadId == null ? {} : { threadId: row.threadId }),
      mailUrl: row.mailUrl,
    })),
    page: {
      offset,
      returned: visible.length,
      hasMore,
      nextOffset: hasMore ? offset + visible.length : null,
    },
  };
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
