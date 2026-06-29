import type { Store } from "../../mail-mirror/src/store.ts";
import { parseDetail } from "./parse.ts";
import { readScript } from "./applescript.ts";
import { mailUrl } from "./mail-url.ts";
import { runOsa } from "./osascript.ts";

export interface MailDetail {
  subject: string;
  from: string;
  date: string;
  body: string;
  attachments: { name: string; index: number }[];
  bodyState: string;
  /** Apple Mail deep link — clicking it opens the message in Mail.app. */
  mailUrl: string;
}

export async function readDb(
  store: Store,
  ref: { id?: string; messageId?: string },
  runScoped: (script: string) => Promise<string> = (s) => runOsa(s, { timeoutMs: 90_000 }),
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
  // Only pay for a live read when the mirror has essentially NO body. A "partial"
  // body_state merely reflects Mail's `.partial.emlx` download flag — the text it
  // extracted is the same a live read would return (verified across the whole
  // mirror: 120/120 partials already had the complete body), so serving it
  // straight from SQL avoids a ~tens-of-seconds AppleScript scan for ~half of all
  // messages. Genuinely empty rows (`none`) still fall back to a live read.
  const MIN_BODY_CHARS = 20;
  if (bodyState !== "full" && body.trim().length < MIN_BODY_CHARS) {
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
    mailUrl: mailUrl(messageId),
  };
}
