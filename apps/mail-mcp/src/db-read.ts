import type { Store } from "../../mail-mirror/src/store.ts";
import { parseDetail } from "./parse.ts";
import { readScript } from "./applescript.ts";
import { mailUrl } from "./mail-url.ts";
import { runOsa } from "./osascript.ts";
import { parseEmlxFile } from "../../mail-mirror/src/emlx.ts";
import { extractionIsCurrent, type BodyExtraction } from "../../mail-mirror/src/body.ts";

export interface MailDetail {
  subject: string;
  from: string;
  date: string;
  body: string;
  attachments: { name: string; index: number }[];
  bodyState: string;
  bodyExtraction?: BodyExtraction;
  /** Apple Mail deep link — clicking it opens the message in Mail.app. */
  mailUrl: string;
}

export async function readDb(
  store: Store,
  ref: { id?: string; messageId?: string },
  runScoped: (script: string) => Promise<string> = (s) => runOsa(s, { timeoutMs: 90_000 }),
  readLocal: typeof parseEmlxFile = parseEmlxFile,
): Promise<MailDetail> {
  const messageId = ref.messageId ?? ref.id ?? "";
  const live = store.raw
    .prepare("SELECT deleted FROM messages WHERE message_id=?")
    .get(messageId) as { deleted: number } | undefined;
  if (!live || live.deleted) throw new Error(`Message not found in the mail mirror: ${messageId}`);
  const row = store.getMessage(messageId);
  if (!row) throw new Error(`Message not found in the mail mirror: ${messageId}`);

  const attRows = store.raw
    .prepare("SELECT filename FROM attachments WHERE message_id=?")
    .all(messageId) as { filename: string }[];
  const attachments = attRows.map((a, i) => ({ name: a.filename, index: i + 1 }));

  let body = row.bodyText;
  let bodyState = row.bodyState;
  let bodyExtraction = row.bodyExtraction;
  if (!extractionIsCurrent(body, bodyExtraction) && row.emlxPath) {
    try {
      const local = await readLocal(row.emlxPath);
      if (local.messageId === messageId && local.bodyText.trim() && local.bodyExtraction) {
        body = local.bodyText;
        bodyExtraction = local.bodyExtraction;
        if (bodyState === "none") bodyState = "partial";
        if (!store.raw.readonly) store.updateBody(messageId, row.bodyText, body, bodyExtraction);
      }
    } catch { /* Missing local source: keep the existing body and the live fallback. */ }
  }
  // Download completeness and extraction quality are independent. Do not live-read
  // a valid short reply just because its file is partial; do recover an empty
  // full download instead of treating "full" as proof that its text is usable.
  const MIN_BODY_CHARS = 20;
  const knownExtraction = !!bodyExtraction && bodyExtraction.quality !== "unavailable";
  const needsLive = !body.trim() || bodyExtraction?.quality === "unavailable" || (!knownExtraction && bodyState !== "full");
  if (needsLive && body.trim().length < MIN_BODY_CHARS) {
    // Live read via the GLOBAL finder (readScript): prefers Mail's indexed numeric
    // `id`, falls back to a global `whose message id is` scan. If it fails, keep
    // whatever the mirror had rather than failing the whole read.
    try {
      const out = await runScoped(readScript({ id: ref.id, messageId }));
      const detail = parseDetail(out);
      // Only adopt the live body if it's actually richer than what the mirror
      // has. Some mails (e.g. a ticket whose content is in PDF attachments) have
      // an empty plain-text `content` live — don't let that clobber a good
      // partial body the mirror already extracted.
      if (
        detail.body &&
        !detail.body.startsWith("[body unavailable") &&
        detail.body.trim().length > body.trim().length
      ) {
        body = detail.body;
        bodyState = "full";
        bodyExtraction = undefined; // A live Mail.app read has no MIME extraction provenance.
      }
    } catch {
      // keep the mirror's partial body + bodyState
    }
  }
  return {
    subject: row.subject,
    from: row.fromName ? `${row.fromName} <${row.fromAddr}>` : row.fromAddr,
    date: new Date(row.date * 1000).toISOString(),
    body,
    attachments,
    bodyState,
    ...(bodyExtraction ? { bodyExtraction } : {}),
    mailUrl: mailUrl(messageId),
  };
}
