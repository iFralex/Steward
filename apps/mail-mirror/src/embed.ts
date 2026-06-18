import { createHash } from "node:crypto";
import type { MessageRow, Store } from "./store.ts";

const MAX_CHARS = Number(process.env.MAIL_EMBED_MAX_CHARS ?? 2000);

export function sourceTextFor(row: MessageRow): string {
  return `${row.subject}\n${row.bodyText}`.slice(0, MAX_CHARS);
}

export function sourceHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface EmbedDeps {
  store: Store;
  embed: (text: string) => Promise<number[] | null>;
  model: string;
}

export async function embedMessage(
  deps: EmbedDeps,
  messageId: string,
): Promise<"embedded" | "skipped" | "unavailable" | "missing"> {
  const row = deps.store.getMessage(messageId);
  if (!row) return "missing";
  const text = sourceTextFor(row);
  const hash = sourceHash(text);
  const state = deps.store.embedStateFor(messageId);
  if (state && state.sourceHash === hash) return "skipped";
  const vector = await deps.embed(text);
  if (!vector) return "unavailable";
  deps.store.ensureVecTable(vector.length);
  deps.store.upsertEmbedding(messageId, vector, deps.model, hash);
  return "embedded";
}
