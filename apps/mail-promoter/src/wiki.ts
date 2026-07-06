// apps/mail-promoter/src/wiki.ts
import { writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { recordAudit } from "@steward/audit-log";

export interface WikiPromoter {
  addSources(projectId: string, sources: { filename: string; content: string }[], rescan?: boolean): Promise<unknown>;
  removeSource?(projectId: string, filename: string): Promise<unknown>;
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
      for (const s of sources) {
        const target = join(sourcesDir, s.filename);
        const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(temp, s.content);
        renameSync(temp, target);
      }
      return {};
    },
    async removeSource(_projectId, filename) {
      try { unlinkSync(join(sourcesDir, filename)); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
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
export async function promote(
  note: { filename: string; content: string },
  client: WikiPromoter,
  projectId = "current",
  rescan = true,
  previousFilename?: string | null,
): Promise<void> {
  const startedAt = Date.now();
  try {
    await client.addSources(projectId, [note], rescan);
    if (previousFilename && previousFilename !== note.filename) {
      await client.removeSource?.(projectId, previousFilename);
    }
    recordAudit({
      actor: "scheduler",
      eventType: "wiki.promoted",
      risk: "low",
      summary: `Promoted mail note to wiki: ${note.filename}`,
      ok: true,
      durationMs: Date.now() - startedAt,
      payload: { projectId, filename: note.filename, content: note.content, rescan, replacedFilename: previousFilename ?? null },
      sourceRefs: [{ type: "wiki", label: note.filename }],
    });
  } catch (err) {
    recordAudit({
      actor: "scheduler",
      eventType: "wiki.promote_failed",
      risk: "medium",
      summary: err instanceof Error ? err.message : String(err),
      ok: false,
      durationMs: Date.now() - startedAt,
      payload: { projectId, filename: note.filename, rescan },
    });
    throw err;
  }
}
