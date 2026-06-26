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
  attachments?: PromotedAttachment[];
}): { filename: string; content: string } {
  const { msg, accountLabel, distilled, categories, threadId, messageIds, attachments = [] } = args;
  const from = msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr;
  const fm = [
    "---",
    `source: message://${msg.messageId}`,
    ...(threadId != null ? [`thread: thread://${threadId}`] : []),
    ...(messageIds && messageIds.length > 1 ? [`messages: [${messageIds.join(", ")}]`] : []),
    ...(attachments.length ? [`attachments: [${attachments.map((a) => a.relativePath).join(", ")}]`] : []),
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
    section("Organizations", distilled.orgs) +
    attachmentSection(attachments);
  return {
    filename: threadId != null ? filenameForThread(threadId) : `mail-${slugForMessageId(msg.messageId)}.md`,
    content: fm + body,
  };
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[[\]]/g, "\\$&");
}

function attachmentSection(attachments: PromotedAttachment[]): string {
  if (!attachments.length) return "";
  return `\n## Attachments\n${attachments
    .map((a) => `- [${escapeMarkdownLabel(a.filename)}](${a.relativePath})`)
    .join("\n")}\n`;
}

export function withAttachmentReferences(
  content: string,
  attachments: PromotedAttachment[],
): string {
  const desiredFrontmatter = attachments.length
    ? `attachments: [${attachments.map((a) => a.relativePath).join(", ")}]`
    : "";
  const desiredSection = attachmentSection(attachments);
  if (
    (!desiredFrontmatter || content.includes(`\n${desiredFrontmatter}\n`))
    && (!desiredSection || content.endsWith(desiredSection))
  ) {
    return content;
  }
  const withoutSection = content.replace(/\n## Attachments\n[\s\S]*?(?=\n## |\s*$)/, "").trimEnd();
  const lines = withoutSection.split("\n");
  const close = lines.indexOf("---", 1);
  if (close < 0) throw new Error("Mail note is missing frontmatter");
  const filtered = lines.filter((line, index) => index > close || !line.startsWith("attachments:"));
  if (attachments.length) {
    const nextClose = filtered.indexOf("---", 1);
    filtered.splice(nextClose, 0, desiredFrontmatter);
  }
  return filtered.join("\n").trimEnd() + (desiredSection ? `\n${desiredSection}` : "\n");
}
import type { PromotedAttachment } from "./attachments.ts";
