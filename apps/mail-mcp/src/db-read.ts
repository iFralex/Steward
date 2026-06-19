import type { Store } from "../../mail-mirror/src/store.ts";
import { parseDetail } from "./parse.ts";
import { scopedReadScript } from "./applescript.ts";
import { runOsa } from "./osascript.ts";

export interface MailDetail {
  subject: string;
  from: string;
  date: string;
  body: string;
  attachments: { name: string; index: number }[];
  bodyState: string;
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
  if (row.bodyState !== "full") {
    const out = await runScoped(scopedReadScript(row.account, row.mailbox, messageId));
    const detail = parseDetail(out);
    if (detail.body && !detail.body.startsWith("[body unavailable")) {
      body = detail.body;
      bodyState = "full";
    }
  }
  return {
    subject: row.subject,
    from: row.fromName ? `${row.fromName} <${row.fromAddr}>` : row.fromAddr,
    date: new Date(row.date * 1000).toISOString(),
    body,
    attachments,
    bodyState,
  };
}
