const CARD_LANGUAGE = "card";
const SUPPORTED_CARD_TYPES = new Set([
  "email", "event", "events", "contact", "contacts", "command", "action",
  "source-write", "operation", "search", "file",
]);

export interface InlineCardPayload {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Models occasionally emit a fenced block as "```\ncard\n{...}\n```" instead
 * of putting the info string on the opening fence. CommonMark treats that as
 * an ordinary code block, so repair this narrow, protocol-specific variant
 * before handing the text to react-markdown.
 */
export function normalizeInlineCardMarkdown(text: string): string {
  return text.replace(
    /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*\r?\n[ \t]*card[ \t]*\r?$/gim,
    (_match, indent: string, fence: string) => `${indent}${fence}${CARD_LANGUAGE}`,
  );
}

/** react-markdown normally emits `language-card`; tolerate extra classes/case. */
export function isInlineCardLanguage(className: string | undefined): boolean {
  return (className ?? "")
    .split(/\s+/)
    .some((value) => value.toLowerCase() === `language-${CARD_LANGUAGE}`);
}

/** Parse only an object with a non-empty type. Invalid/incomplete JSON stays code. */
export function parseInlineCardJson(value: unknown): InlineCardPayload | null {
  try {
    const parsed = JSON.parse(String(value).trim()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== "string" || !obj.type.trim()) return null;
    const normalizedType = obj.type.trim().toLowerCase();
    if (!SUPPORTED_CARD_TYPES.has(normalizedType)) return null;
    const data = { ...obj };
    delete data.type;
    return { type: normalizedType, data };
  } catch {
    return null;
  }
}
