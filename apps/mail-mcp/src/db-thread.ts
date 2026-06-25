import type { Store } from "../../mail-mirror/src/store.ts";
import type { MessageSummary } from "./types.ts";
import { mailUrl } from "./mail-url.ts";

export function getThread(store: Store, ref: { threadId?: number; id?: string; messageId?: string }): MessageSummary[] {
  let threadId = ref.threadId;
  if (threadId == null) {
    const key = ref.messageId ?? ref.id ?? "";
    const r = store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=? AND deleted=0").get(key) as { thread_id: number | null } | undefined;
    if (!r || r.thread_id == null) throw new Error(`Cannot resolve a thread for: ${key}`);
    threadId = r.thread_id;
  }
  const rows = store.raw.prepare(
    `SELECT message_id, subject, from_addr, from_name, date, mailbox, account, snippet, thread_id
     FROM messages WHERE thread_id=? AND deleted=0 ORDER BY date ASC`,
  ).all(threadId) as { message_id: string; subject: string; from_addr: string; from_name: string; date: number; mailbox: string; account: string; snippet: string; thread_id: number | null }[];
  return rows.map((m) => ({
    id: m.message_id,
    messageId: m.message_id,
    mailUrl: mailUrl(m.message_id),
    subject: m.subject ?? "",
    from: m.from_name ? `${m.from_name} <${m.from_addr}>` : (m.from_addr ?? ""),
    date: new Date(m.date * 1000).toISOString(),
    mailbox: m.mailbox ?? "",
    account: m.account ?? "",
    snippet: m.snippet ?? "",
    threadId: m.thread_id ?? undefined,
  }));
}
