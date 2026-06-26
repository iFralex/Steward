import { existsSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../../mail-mirror/src/store.ts";
import type { PromoteState } from "./state.ts";
import { syncThreadAttachments } from "./attachments.ts";
import { filenameForThread, withAttachmentReferences } from "./note.ts";

export interface PromotedAttachmentSyncSummary {
  threads: number;
  notesUpdated: number;
  attachmentsLinked: number;
  blobsCopied: number;
  blobsAlreadyPresent: number;
  skippedAttachments: number;
  missingNotes: number;
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

/** Sync attachments for already-promoted threads without calling the LLM. */
export function syncPromotedThreadAttachments(args: {
  store: Store;
  state: PromoteState;
  blobRoot: string;
  sourcesDir: string;
  maxBytes?: number;
}): PromotedAttachmentSyncSummary {
  const summary: PromotedAttachmentSyncSummary = {
    threads: 0,
    notesUpdated: 0,
    attachmentsLinked: 0,
    blobsCopied: 0,
    blobsAlreadyPresent: 0,
    skippedAttachments: 0,
    missingNotes: 0,
  };

  for (const record of args.state.promotedThreadRecords()) {
    const match = /^thread:(\d+)$/.exec(record.messageId);
    if (!match) continue;
    const threadId = Number(match[1]);
    const filename = record.wikiFilename ?? filenameForThread(threadId);
    const notePath = join(args.sourcesDir, filename);
    if (!existsSync(notePath)) {
      summary.missingNotes++;
      continue;
    }
    summary.threads++;
    const synced = syncThreadAttachments({
      store: args.store,
      threadId,
      blobRoot: args.blobRoot,
      sourcesDir: args.sourcesDir,
      maxBytes: args.maxBytes,
    });
    summary.attachmentsLinked += synced.attachments.length;
    summary.blobsCopied += synced.copied;
    summary.blobsAlreadyPresent += synced.alreadyPresent;
    summary.skippedAttachments += synced.skipped;

    const before = readFileSync(notePath, "utf8");
    const after = withAttachmentReferences(before, synced.attachments);
    if (after !== before) {
      atomicWrite(notePath, after);
      summary.notesUpdated++;
    }
  }
  const legacyDir = join(args.sourcesDir, "mail-attachments");
  if (existsSync(legacyDir)) {
    for (const filename of readdirSync(legacyDir)) {
      const path = join(legacyDir, filename);
      try { unlinkSync(path); } catch { /* leave unexpected entries alone */ }
    }
    try { rmSync(legacyDir, { recursive: false }); } catch { /* non-empty or already absent */ }
  }
  return summary;
}
