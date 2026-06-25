// apps/mail-promoter/src/note.ts
export interface DistilledNote {
  summary: string;
  facts: string[];
  commitments: string[];
  people: string[];
  orgs: string[];
  /** When to revisit this note (YYYY-MM-DD) — a future deadline/event/action; null if timeless. */
  reviewBy?: string | null;
}

export function slugForMessageId(messageId: string): string {
  const s = messageId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 80) || "msg";
}

export function filenameForThread(threadId: number): string {
  if (!Number.isSafeInteger(threadId) || threadId <= 0) throw new Error(`Invalid thread id: ${threadId}`);
  return `mail-thread-${threadId}.md`;
}

function section(title: string, items: string[]): string {
  if (!items.length) return "";
  return `\n## ${title}\n${items.map((i) => `- ${i}`).join("\n")}\n`;
}

export function buildNote(args: {
  msg: { messageId: string; fromName: string; fromAddr: string; subject: string; date: number; account: string };
  accountLabel: string;
  distilled: DistilledNote;
  categories: string[];
  threadId?: number;
  messageIds?: string[];
}): { filename: string; content: string } {
  const { msg, accountLabel, distilled, categories, threadId, messageIds } = args;
  const from = msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr;
  const fm = [
    "---",
    `source: message://${msg.messageId}`,
    ...(threadId != null ? [`thread: thread://${threadId}`] : []),
    ...(messageIds && messageIds.length > 1 ? [`messages: [${messageIds.join(", ")}]`] : []),
    ...(distilled.reviewBy ? [`review_by: ${distilled.reviewBy}`] : []),
    `subject: ${msg.subject}`,
    `from: ${from}`,
    `date: ${new Date(msg.date * 1000).toISOString()}`,
    `account: ${accountLabel}`,
    `categories: [${categories.join(", ")}]`,
    "---",
    "",
  ].join("\n");
  const body =
    `${distilled.summary}\n` +
    section("Facts", distilled.facts) +
    section("Commitments", distilled.commitments) +
    section("People", distilled.people) +
    section("Organizations", distilled.orgs);
  return {
    filename: threadId != null ? filenameForThread(threadId) : `mail-${slugForMessageId(msg.messageId)}.md`,
    content: fm + body,
  };
}
