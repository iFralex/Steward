import type { MessageSummary } from "./types.ts";

export const DEFAULT_THREAD_PAGE_SIZE = 10;
export const MAX_THREAD_PAGE_SIZE = 30;
const FULL_SNIPPET_MESSAGES = 3;
const FULL_SNIPPET_CHARS = 180;
const COMPACT_SNIPPET_CHARS = 80;

export type ThreadPageArgs = {
  limit?: number;
  offset?: number;
};

export type CompactThreadMessage = Omit<MessageSummary, "messageId" | "threadId" | "snippet"> & {
  snippet: string;
};

export type ThreadPage = {
  messages: CompactThreadMessage[];
  page: {
    total: number;
    offset: number;
    returned: number;
    hasEarlier: boolean;
    earlierOffset?: number;
    hasLater: boolean;
    laterOffset?: number;
  };
};

function boundedInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(0, Math.trunc(parsed)));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function buildThreadPage(rows: MessageSummary[], args: ThreadPageArgs = {}): ThreadPage {
  const limit = Math.max(1, boundedInteger(args.limit, DEFAULT_THREAD_PAGE_SIZE, MAX_THREAD_PAGE_SIZE));
  const requestedOffset = args.offset == null ? null : boundedInteger(args.offset, 0, Number.MAX_SAFE_INTEGER);
  // The latest state of a conversation is normally the most useful. Keep the
  // selected page chronological so the model can still follow the exchange.
  const offset = requestedOffset ?? Math.max(0, rows.length - limit);
  const selected = rows.slice(offset, offset + limit);

  const messages = selected.map((row, index) => {
    const maxSnippet = index >= selected.length - FULL_SNIPPET_MESSAGES
      ? FULL_SNIPPET_CHARS
      : COMPACT_SNIPPET_CHARS;
    const { messageId: _duplicateMessageId, threadId: _repeatedThreadId, ...rest } = row;
    return { ...rest, snippet: truncate(row.snippet ?? "", maxSnippet) };
  });

  const returned = messages.length;
  const hasEarlier = offset > 0;
  const hasLater = offset + returned < rows.length;
  return {
    messages,
    page: {
      total: rows.length,
      offset,
      returned,
      hasEarlier,
      ...(hasEarlier ? { earlierOffset: Math.max(0, offset - limit) } : {}),
      hasLater,
      ...(hasLater ? { laterOffset: offset + returned } : {}),
    },
  };
}
