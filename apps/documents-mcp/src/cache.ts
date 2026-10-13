import type { ExtractedDocument } from "./types.ts";

const MAX_ENTRIES = 8;
const entries = new Map<string, ExtractedDocument>();

export function cachedDocument(key: string): ExtractedDocument | undefined {
  const value = entries.get(key);
  if (!value) return undefined;
  entries.delete(key);
  entries.set(key, value);
  return value;
}

export function cacheDocument(document: ExtractedDocument): ExtractedDocument {
  entries.set(document.cacheKey, document);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  return document;
}

export function clearDocumentCache(): void {
  entries.clear();
}
