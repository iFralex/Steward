import { existsSync } from "node:fs";
import { parseEmlxFile } from "./emlx.ts";
import { enumerateEmlx } from "./locator.ts";
import { normalizeSubject } from "./threads.ts";
import type { BlobStore } from "./blobstore.ts";
import type { BodyState, MessageRow, Store } from "./store.ts";
import type { EmlxEntry, ParsedMessage } from "./types.ts";
import { refreshIdentity } from "./enrich.ts";

export interface SyncDeps {
  store: Store;
  blobs: BlobStore;
}

export function bodyStateFor(isPartial: boolean, bodyText: string): BodyState {
  if (!isPartial) return "full";
  return bodyText.trim().length > 0 ? "partial" : "none";
}

function isAllMail(mailbox: string): boolean {
  const m = (mailbox || "").toLowerCase();
  return m.includes("all mail") || m.includes("tutti i messaggi") || m === "[gmail]" || m === "[google mail]";
}

/** Resolve (and persist) a surrogate thread_id for a message, before it is upserted. */
function resolveThreadId(store: Store, m: ParsedMessage & { messageId: string }): number {
  const db = store.raw;
  // 0) Own existing thread: re-ingest of a known message keeps its thread (avoids orphan-thread churn).
  const own = db.prepare("SELECT thread_id FROM messages WHERE message_id=? AND thread_id IS NOT NULL").get(m.messageId) as { thread_id: number } | undefined;
  if (own?.thread_id != null) return own.thread_id;
  // 1) Gmail thread id groups messages with no usable References (e.g. distinct subjects).
  if (m.gmThrid) {
    const row = db.prepare("SELECT thread_id FROM messages WHERE gm_thrid=? AND thread_id IS NOT NULL LIMIT 1").get(m.gmThrid) as { thread_id: number } | undefined;
    if (row?.thread_id != null) return row.thread_id;
  }
  const linkedIds = [m.inReplyTo, ...m.references].filter((x): x is string => !!x);
  // 2) Any already-stored linked message shares its thread.
  for (const id of linkedIds) {
    const row = db.prepare("SELECT thread_id FROM messages WHERE message_id=? AND thread_id IS NOT NULL").get(id) as { thread_id: number } | undefined;
    if (row?.thread_id != null) return row.thread_id;
  }
  // 3) Subject + participant + 14-day fallback.
  const subj = normalizeSubject(m.subject);
  if (subj) {
    const since = m.date - 14 * 86400;
    const until = m.date + 14 * 86400;
    const cand = db
      .prepare("SELECT thread_id, from_addr, to_addrs FROM messages WHERE thread_id IS NOT NULL AND date BETWEEN ? AND ? AND subject LIKE ? ESCAPE '\\'")
      .all(since, until, "%" + subj.replace(/[\\%_]/g, "\\$&") + "%") as { thread_id: number; from_addr: string; to_addrs: string }[];
    const parts = new Set<string>([m.fromAddr, ...m.to]);
    for (const c of cand) {
      const cParts = new Set<string>([c.from_addr, ...JSON.parse(c.to_addrs || "[]")]);
      if ([...parts].some((p) => p && cParts.has(p))) return c.thread_id;
    }
  }
  // 4) New thread.
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

  const existing = deps.store.getMessage(messageId);
  const isNew = existing === undefined;
  // Mailbox precedence: keep the most specific mailbox/path. Do not let an All-Mail copy
  // overwrite a row already attributed to a specific mailbox (Gmail dupes the message everywhere).
  const keepExisting = existing != null && isAllMail(entry.mailbox) && !isAllMail(existing.mailbox);
  const mailbox = keepExisting ? existing!.mailbox : entry.mailbox;
  const emlxPath = keepExisting ? existing!.emlxPath : entry.path;

  const row: MessageRow = {
    messageId,
    account: entry.account,
    mailbox,
    fromName: parsed.fromName,
    fromAddr: parsed.fromAddr,
    to: parsed.to,
    cc: parsed.cc,
    toNames: parsed.toNames,
    ccNames: parsed.ccNames,
    subject: parsed.subject,
    date: parsed.date,
    bodyText: parsed.bodyText,
    bodyState: bodyStateFor(entry.isPartial, parsed.bodyText),
    source: "emlx",
    emlxPath,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    gmThrid: parsed.gmThrid,
    size: parsed.attachments.reduce((n, a) => n + a.size, parsed.bodyText.length),
    unread: parsed.flags ? !parsed.flags.read : false,
    flagged: parsed.flags?.flagged ?? false,
    answered: parsed.flags?.answered ?? false,
    junk: parsed.flags?.junk ?? false,
    flagColor: parsed.flagColor,
    appleThrid: parsed.appleThrid,
  };
  deps.store.upsertMessage(row);
  deps.store.setThreadId(messageId, threadId);
  deps.store.recordPath(messageId, entry.path, entry.mailbox, entry.isPartial, entry.mtimeMs);
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
    if (id) ingested++;
  }
  deps.store.setState("backfill.ingested", String(ingested));
  return { ingested };
}

export async function reconcile(deps: SyncDeps, mailRoot: string): Promise<{ ingested: number; deleted: number }> {
  const entries = enumerateEmlx(mailRoot);
  const onDisk = new Set(entries.map((e) => e.path));
  const known = deps.store.allKnownPaths();
  let ingested = 0;
  for (const e of entries) {
    if (!known.has(e.path)) {
      if (await ingestEmlxFile(deps, e)) ingested++;
    } else {
      const prev = deps.store.pathMtime(e.path);
      if (prev === undefined || e.mtimeMs > prev) {
        if (await ingestEmlxFile(deps, e)) ingested++;
      }
    }
  }
  // Newly appeared account? refresh identity so its name/emails/roles are known.
  const unknown = entries.find((e) => !deps.store.hasAccount(e.account));
  if (unknown) { try { await refreshIdentity({ store: deps.store, mailRoot }); } catch { /* best-effort */ } }

  // Prune dead paths; soft-delete a message only when NONE of its paths remain.
  const affected = new Set<string>();
  for (const path of known) {
    if (!onDisk.has(path) && !existsSync(path)) {
      const mid = deps.store.removePath(path);
      if (mid) affected.add(mid);
    }
  }
  let deleted = 0;
  for (const mid of affected) {
    if (!deps.store.messageHasPath(mid)) {
      deps.store.softDelete(mid);
      deleted++;
    }
  }
  return { ingested, deleted };
}
