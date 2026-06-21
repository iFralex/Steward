import { createHash } from "node:crypto";
import { embedTexts } from "@llm-wiki/search";
import type { EmbeddingConfig } from "@llm-wiki/embedding";
import { displayNameOf, type IndexDb } from "./index-db.ts";
import type { Contact } from "./types.ts";

function embedFields(c: Contact): string {
  return [displayNameOf(c), c.organization ?? "", c.nickname ?? "", c.note ?? ""].filter(Boolean).join("\n");
}

export function sourceHash(c: Contact): string {
  return createHash("sha1").update(embedFields(c)).digest("hex");
}

export interface SyncDeps {
  store: { allForIndex(): Contact[] };
  index: IndexDb;
  embedConfig: EmbeddingConfig | null;
  embedBatch?: (texts: string[], cfg: EmbeddingConfig) => Promise<(number[] | null)[]>;
}

export async function syncIndex(deps: SyncDeps): Promise<{ upserted: number; embedded: number; deleted: number }> {
  const contacts = deps.store.allForIndex();
  let upserted = 0;
  const toEmbed: { uid: string; rowid: number; text: string; hash: string }[] = [];
  for (const c of contacts) {
    const hash = sourceHash(c);
    const rowid = deps.index.upsertContact(c, hash);
    upserted++;
    if (deps.embedConfig && deps.index.embedStateFor(c.uid)?.sourceHash !== hash) {
      toEmbed.push({ uid: c.uid, rowid, text: embedFields(c), hash });
    }
  }
  const deleted = deps.index.deleteMissing(contacts.map((c) => c.uid));

  let embedded = 0;
  if (deps.embedConfig && toEmbed.length) {
    const batch = deps.embedBatch ?? embedTexts;
    const vectors = await batch(toEmbed.map((t) => t.text), deps.embedConfig);
    deps.index.vectors.enable();
    for (let i = 0; i < toEmbed.length; i++) {
      const v = vectors[i];
      if (!v) continue;
      deps.index.vectors.ensureTable(v.length);
      deps.index.vectors.upsert(toEmbed[i].rowid, v);
      deps.index.recordEmbed(toEmbed[i].uid, toEmbed[i].hash, v.length, deps.embedConfig.model);
      embedded++;
    }
  }
  return { upserted, embedded, deleted };
}
