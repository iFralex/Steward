import type { Store, MessageRow } from "../../mail-mirror/src/store.ts";
import { cleanBody } from "./clean-body.ts";

export interface ThreadInput {
  threadId: number;
  messages: MessageRow[];
  primary: MessageRow; // most recent message — drives filename, source backlink, and Date context
  messageIds: string[];
  fromName: string;
  fromAddr: string;
  subject: string;
  date: number;
  to: string[];
  cc: string[];
  bodyText: string; // rendered, per-message-cleaned transcript (chronological)
}

const THREAD_TRANSCRIPT_MAX_CHARS = 14_000;

/**
 * Assemble one thread into a single triage input: every non-deleted message in
 * chronological order, each body cleaned individually (cleaning the whole
 * concatenation would cut at quote markers and drop later messages), plus
 * aggregated recipients so triage can judge the user's involvement.
 */
export function buildThreadInput(store: Store, threadId: number): ThreadInput | null {
  const ids = (store.raw
    .prepare("SELECT message_id FROM messages WHERE thread_id=? AND deleted=0 ORDER BY date ASC")
    .all(threadId) as { message_id: string }[]).map((r) => r.message_id);
  const messages = ids.map((id) => store.getMessage(id)).filter((m): m is MessageRow => !!m);
  if (!messages.length) return null;

  const initiator = messages[0];
  const primary = messages[messages.length - 1];
  const to = [...new Set(messages.flatMap((m) => m.to))].filter(Boolean);
  const cc = [...new Set(messages.flatMap((m) => m.cc))].filter(Boolean);
  const rendered = messages.map((m) => {
      const who = m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr;
      const when = new Date(m.date * 1000).toISOString().slice(0, 10);
      return `--- From: ${who} — ${when} ---\n${cleanBody(m.bodyText).slice(0, 4000)}`;
    });
  const selected: string[] = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const separator = selected.length ? 2 : 0;
    const remaining = THREAD_TRANSCRIPT_MAX_CHARS - used - separator;
    if (remaining <= 0) break;
    const segment = rendered[i];
    if (segment.length <= remaining) {
      selected.unshift(segment);
      used += segment.length + separator;
    } else if (selected.length === 0) {
      selected.unshift(segment.slice(-remaining));
      used += remaining;
    } else {
      break;
    }
  }
  const omitted = rendered.length - selected.length;
  const bodyText = `${omitted > 0 ? `[${omitted} earlier message(s) omitted to preserve the newest context]\n\n` : ""}${selected.join("\n\n")}`;

  return {
    threadId,
    messages,
    primary,
    messageIds: messages.map((m) => m.messageId),
    fromName: initiator.fromName,
    fromAddr: initiator.fromAddr,
    subject: initiator.subject || primary.subject,
    date: primary.date,
    to,
    cc,
    bodyText,
  };
}
