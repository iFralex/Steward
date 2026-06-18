import { existsSync } from "node:fs";
import { parseEmlxFile } from "./emlx.ts";
import { enumerateEmlx } from "./locator.ts";
import { normalizeSubject } from "./threads.ts";
import type { BlobStore } from "./blobstore.ts";
import type { BodyState, MessageRow, Store } from "./store.ts";
import type { EmlxEntry, ParsedMessage } from "./types.ts";

export interface SyncDeps {
  store: Store;
  blobs: BlobStore;
}

export function bodyStateFor(isPartial: boolean, bodyText: string): BodyState {
  if (!isPartial) return "full";
  return bodyText.trim().length > 0 ? "partial" : "none";
}

/** Resolve (and persist) a surrogate thread_id for a message, before it is upserted. */
function resolveThreadId(store: Store, m: ParsedMessage & { messageId: string }): number {
  const db = store.raw;
  const linkedIds = [m.inReplyTo, ...m.references].filter((x): x is string => !!x);
  // 1) Any already-stored linked message shares its thread.
  for (const id of linkedIds) {
    const row = db.prepare("SELECT thread_id FROM messages WHERE message_id=? AND thread_id IS NOT NULL").get(id) as { thread_id: number } | undefined;
    if (row?.thread_id != null) return row.thread_id;
  }
  // 2) Subject + participant + 14-day fallback.
  const subj = normalizeSubject(m.subject);
  if (subj) {
    const since = m.date - 14 * 86400;
    const until = m.date + 14 * 86400;
    const cand = db
      .prepare("SELECT thread_id, from_addr, to_addrs FROM messages WHERE thread_id IS NOT NULL AND date BETWEEN ? AND ? AND subject LIKE ?")
      .all(since, until, "%" + subj + "%") as { thread_id: number; from_addr: string; to_addrs: string }[];
    const parts = new Set<string>([m.fromAddr, ...m.to]);
    for (const c of cand) {
      const cParts = new Set<string>([c.from_addr, ...JSON.parse(c.to_addrs || "[]")]);
      if ([...parts].some((p) => p && cParts.has(p))) return c.thread_id;
    }
  }
  // 3) New thread.
  const info = db.prepare("INSERT INTO threads(subject, participants, first_date, last_date, msg_count) VALUES (?,?,?,?,0)").run(subj, JSON.stringify([m.fromAddr, ...m.to]), m.date, m.date);
  return Number(info.lastInsertRowid);
}

function bumpThread(store: Store, threadId: number, date: number): void {
  store.raw
    .prepare("UPDATE threads SET msg_count=msg_count+1, first_date=MIN(first_date,?), last_date=MAX(last_date,?) WHERE id=?")
    .run(date, date, threadId);
}

export async function ingestEmlxFile(deps: SyncDeps, entry: EmlxEntry): Promise<string | null> {
  let parsed: ParsedMessage;
  try {
    parsed = await parseEmlxFile(entry.path);
  } catch {
    return null; // malformed; caller may fall back to AppleScript
  }
  const messageId = parsed.messageId || `nomsgid:${entry.account}:${entry.path}`;
  const threadId = resolveThreadId(deps.store, { ...parsed, messageId });

  const row: MessageRow = {
    messageId,
    account: entry.account,
    mailbox: entry.mailbox,
    fromName: parsed.fromName,
    fromAddr: parsed.fromAddr,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    date: parsed.date,
    bodyText: parsed.bodyText,
    bodyState: bodyStateFor(entry.isPartial, parsed.bodyText),
    source: "emlx",
    emlxPath: entry.path,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    gmThrid: parsed.gmThrid,
    size: parsed.attachments.reduce((n, a) => n + a.size, parsed.bodyText.length),
  };
  const isNew = deps.store.getMessage(messageId) === undefined;
  deps.store.upsertMessage(row);
  deps.store.setThreadId(messageId, threadId);
  if (isNew) bumpThread(deps.store, threadId, parsed.date);

  const atts = parsed.attachments.map((a) => {
    const { sha256, relPath } = deps.blobs.put(a.content);
    return { filename: a.filename, mime: a.mime, size: a.size, sha256, relPath, downloaded: true };
  });
  if (atts.length) deps.store.insertAttachments(messageId, atts);
  return messageId;
}

export async function backfill(deps: SyncDeps, mailRoot: string, opts: { recentMonths?: number } = {}): Promise<{ ingested: number }> {
  const entries = enumerateEmlx(mailRoot).sort((a, b) => b.mtimeMs - a.mtimeMs); // recent-first
  let ingested = 0;
  for (const e of entries) {
    const id = await ingestEmlxFile(deps, e);
    if (id) {
      ingested++;
      deps.store.setState("backfill.last_path", e.path);
      deps.store.setState("backfill.ingested", String(ingested));
    }
  }
  return { ingested };
}

export async function reconcile(deps: SyncDeps, mailRoot: string): Promise<{ ingested: number; deleted: number }> {
  const entries = enumerateEmlx(mailRoot);
  const onDisk = new Set(entries.map((e) => e.path));
  const known = deps.store.allMessageIdsByPath(); // path -> messageId
  let ingested = 0;
  for (const e of entries) {
    if (!known.has(e.path)) {
      const id = await ingestEmlxFile(deps, e);
      if (id) ingested++;
    }
  }
  let deleted = 0;
  for (const [path, messageId] of known) {
    if (!onDisk.has(path) && !existsSync(path)) {
      deps.store.softDelete(messageId);
      deleted++;
    }
  }
  return { ingested, deleted };
}
