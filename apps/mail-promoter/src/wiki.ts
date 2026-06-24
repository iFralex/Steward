// apps/mail-promoter/src/wiki.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface WikiPromoter {
  addSources(projectId: string, sources: { filename: string; content: string }[], rescan?: boolean): Promise<unknown>;
}

/**
 * A WikiPromoter that writes notes straight into the project's sources directory
 * on disk, bypassing the desktop app's HTTP API. This decouples the backfill from
 * the app entirely: the app can be closed during the run (no watcher work, no
 * per-note indexing, and a crash can't stall the backfill). Indexing happens
 * once, later, via a single `rescan` with the app open.
 */
export function makeFsWikiPromoter(sourcesDir: string): WikiPromoter {
  mkdirSync(sourcesDir, { recursive: true });
  return {
    async addSources(_projectId, sources) {
      for (const s of sources) writeFileSync(join(sourcesDir, s.filename), s.content);
      return {};
    },
  };
}

/**
 * Add a distilled note to the wiki as a source. `LlmWikiApiClient` from the wiki
 * mcp-server satisfies WikiPromoter. Pass `rescan: false` during a bulk backfill
 * (re-indexing + wiki-page regeneration per note is hugely redundant) and run a
 * single rescan at the end instead.
 */
export async function promote(note: { filename: string; content: string }, client: WikiPromoter, projectId = "current", rescan = true): Promise<void> {
  await client.addSources(projectId, [note], rescan);
}
