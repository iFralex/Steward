import { basename, join } from "node:path";
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import type { PromoteState } from "./state.ts";
import { filenameForThread } from "./note.ts";

export interface ThreadNoteMigrationResult {
  migrated: number;
  alreadyCanonical: number;
  recoveredState: number;
  missing: number;
  conflicts: number;
  duplicateNotesRemoved: number;
  canonicalNotesReplaced: number;
}

function safeFilename(filename: string): boolean {
  return basename(filename) === filename && filename.endsWith(".md");
}

/**
 * Rename already-distilled notes to their canonical thread filename and update
 * only wiki_filename in state. Hashes, decisions, timestamps and note contents
 * stay unchanged, so this performs no LLM work and triggers no re-promotion.
 */
export function migratePromotedThreadNotes(
  state: PromoteState,
  sourcesDir: string,
): ThreadNoteMigrationResult {
  const result: ThreadNoteMigrationResult = {
    migrated: 0,
    alreadyCanonical: 0,
    recoveredState: 0,
    missing: 0,
    conflicts: 0,
    duplicateNotesRemoved: 0,
    canonicalNotesReplaced: 0,
  };

  for (const record of state.promotedThreadRecords()) {
    const match = /^thread:(\d+)$/.exec(record.messageId);
    if (!match || !record.wikiFilename || !safeFilename(record.wikiFilename)) {
      result.missing++;
      continue;
    }
    const targetFilename = filenameForThread(Number(match[1]));
    if (record.wikiFilename === targetFilename) {
      result.alreadyCanonical++;
      continue;
    }

    const source = join(sourcesDir, record.wikiFilename);
    const target = join(sourcesDir, targetFilename);
    const sourceExists = existsSync(source);
    const targetExists = existsSync(target);

    if (!sourceExists && targetExists) {
      state.updateWikiFilename(record.messageId, targetFilename);
      result.recoveredState++;
      continue;
    }
    if (!sourceExists) {
      result.missing++;
      continue;
    }
    if (targetExists) {
      if (readFileSync(source, "utf8") !== readFileSync(target, "utf8")) {
        result.conflicts++;
        continue;
      }
      unlinkSync(source);
    } else {
      renameSync(source, target);
    }
    state.updateWikiFilename(record.messageId, targetFilename);
    result.migrated++;
  }

  // Older promoter versions could leave several message-ID-named notes for the
  // same thread. Reconcile those without LLM work: keep the note whose
  // frontmatter has the newest date, make it canonical, remove the stale copies.
  const byThread = new Map<number, Array<{ filename: string; date: number }>>();
  for (const filename of readdirSync(sourcesDir)) {
    if (!/^mail-.*\.md$/.test(filename)) continue;
    const content = readFileSync(join(sourcesDir, filename), "utf8");
    const thread = /^thread:\s*thread:\/\/(\d+)\s*$/m.exec(content);
    if (!thread) continue;
    const date = /^date:\s*(.+)\s*$/m.exec(content);
    const timestamp = date ? Date.parse(date[1]) : Number.NaN;
    const threadId = Number(thread[1]);
    const entries = byThread.get(threadId) ?? [];
    entries.push({ filename, date: Number.isFinite(timestamp) ? timestamp : 0 });
    byThread.set(threadId, entries);
  }

  for (const [threadId, entries] of byThread) {
    if (entries.length < 2) continue;
    const canonical = filenameForThread(threadId);
    entries.sort((a, b) => b.date - a.date || (a.filename === canonical ? -1 : 1));
    const newest = entries[0];
    if (newest.filename !== canonical) {
      renameSync(join(sourcesDir, newest.filename), join(sourcesDir, canonical));
      result.canonicalNotesReplaced++;
    }
    for (const stale of entries.slice(1)) {
      if (stale.filename === canonical || stale.filename === newest.filename) continue;
      try {
        unlinkSync(join(sourcesDir, stale.filename));
        result.duplicateNotesRemoved++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    state.updateWikiFilename(`thread:${threadId}`, canonical);
  }

  return result;
}
