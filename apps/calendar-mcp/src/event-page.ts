import type { CalEvent } from "./types.ts";

export interface CompactEvent extends Omit<CalEvent, "description"> {
  description: string | null;
}

export interface EventSearchPage {
  events: CompactEvent[];
  page: {
    offset: number;
    returned: number;
    hasMore: boolean;
    nextOffset?: number;
  };
}

function truncate(value: string | null, maxChars: number): string | null {
  if (value == null || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function buildEventSearchPage(rows: CalEvent[], limit: number, offset: number): EventSearchPage {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return {
    events: visible.map((event, index) => ({
      ...event,
      description: truncate(event.description, index < 3 ? 300 : 120),
    })),
    page: {
      offset,
      returned: visible.length,
      hasMore,
      ...(hasMore ? { nextOffset: offset + visible.length } : {}),
    },
  };
}
