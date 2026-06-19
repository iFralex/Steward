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

export async function embedBackfill(
  deps: EmbedDeps,
  opts: { limit?: number } = {},
): Promise<{ embedded: number; unavailable: boolean }> {
  const limit = opts.limit ?? 200;
  let embedded = 0;
  for (const row of deps.store.messagesNeedingEmbedding(limit)) {
    const r = await embedMessage(deps, row.messageId);
    if (r === "embedded") embedded++;
    else if (r === "unavailable") return { embedded, unavailable: true }; // endpoint down — stop
  }
  return { embedded, unavailable: false };
}

export function startEmbedWorker(
  deps: EmbedDeps,
  opts: { intervalMs?: number; batch?: number } = {},
): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 10_000;
  const batch = opts.batch ?? 100;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    let delay = intervalMs;
    try {
      const res = await embedBackfill(deps, { limit: batch });
      // If nothing left to do, idle longer; if the endpoint is down, back off.
      if (res.unavailable) delay = intervalMs * 6;
      else if (res.embedded === 0) delay = intervalMs * 3;
      else delay = 250; // more to do — drain quickly
    } catch {
      delay = intervalMs * 6;
    }
    if (!stopped) timer = setTimeout(tick, delay);
  };
  timer = setTimeout(tick, 250);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
