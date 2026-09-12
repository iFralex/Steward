import type { Contact } from "./types.ts";

export interface CompactContact extends Omit<Contact, "note" | "sources"> {
  note: string | null;
}

export interface ContactSearchPage {
  contacts: CompactContact[];
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

export function buildContactSearchPage(rows: Contact[], limit: number, offset: number): ContactSearchPage {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return {
    contacts: visible.map((contact, index) => {
      const { sources: _internalSources, ...rest } = contact;
      return { ...rest, note: truncate(contact.note, index < 3 ? 200 : 100) };
    }),
    page: {
      offset,
      returned: visible.length,
      hasMore,
      ...(hasMore ? { nextOffset: offset + visible.length } : {}),
    },
  };
}
