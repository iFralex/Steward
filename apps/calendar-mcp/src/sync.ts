import { createHash } from "node:crypto";
import { embedTexts } from "@steward/search";
import type { EmbeddingConfig } from "@steward/embedding";
import type { IndexDb } from "./index-db.ts";
import type { CalEvent } from "./types.ts";

export function sourceHash(e: CalEvent): string {
  return createHash("sha1").update(`${e.summary}\n${e.description ?? ""}\n${e.location ?? ""}`).digest("hex");
}

function embedText(e: CalEvent): string {
  return [e.summary, e.description ?? "", e.location ?? ""].filter(Boolean).join("\n");
}

export interface SyncDeps {
  store: { allForIndex(): CalEvent[] };
  index: IndexDb;
  embedConfig: EmbeddingConfig | null;
  embedBatch?: (texts: string[], cfg: EmbeddingConfig) => Promise<(number[] | null)[]>;
}

export async function syncIndex(deps: SyncDeps): Promise<{ upserted: number; embedded: number; deleted: number }> {
  const startedAt = Date.now();
  const events = deps.store.allForIndex();
  let upserted = 0;
  const toEmbed: { uid: string; rowid: number; text: string; hash: string }[] = [];
  const deleted = deps.index.transaction(() => {
    if (Number(deps.index.getState('completed_sync_started_at') ?? 0) > startedAt) return 0;
    const generation = deps.index.beginSyncGeneration();
    for (const e of events) {
      const hash = sourceHash(e);
      const rowid = deps.index.upsertEvent(e, hash, generation);
      upserted++;
      if (deps.embedConfig && deps.index.embedStateFor(e.uid)?.sourceHash !== hash) {
        toEmbed.push({ uid: e.uid, rowid, text: embedText(e), hash });
      }
    }
    const removed = deps.index.deleteMissing(events.map(e => e.uid));
    deps.index.finishSyncGeneration(generation, startedAt);
    return removed;
  });

  let embedded = 0;
  if (deps.embedConfig && toEmbed.length) {
    const batch = deps.embedBatch ?? embedTexts;
    const vectors = await batch(toEmbed.map((t) => t.text), deps.embedConfig);
    for (let i = 0; i < toEmbed.length; i++) {
      const v = vectors[i];
      if (!v) continue;
      const current = deps.index.getEvent(toEmbed[i].uid);
      if (!current || deps.index.uidToRowid(current.uid) !== toEmbed[i].rowid || sourceHash(current) !== toEmbed[i].hash) continue;
      deps.index.vectors.enable();
      deps.index.vectors.ensureTable(v.length);
      deps.index.vectors.upsert(toEmbed[i].rowid, v);
      deps.index.recordEmbed(toEmbed[i].uid, toEmbed[i].hash, v.length, deps.embedConfig.model);
      embedded++;
    }
  }
  return { upserted, embedded, deleted };
}
