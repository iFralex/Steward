import type { Mailbox, MessageSummary } from "./types.ts";

const US = "\x1f";
const RS = "\x1e";

function records(out: string): string[][] {
  return out
    .split(RS)
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => r.split(US));
}

export function parseSummaries(out: string): MessageSummary[] {
  return records(out).map(([messageId, subject, from, date, mailbox, account, snippet]) => ({
    messageId: messageId ?? "",
    subject: subject ?? "",
    from: from ?? "",
    date: date ?? "",
    mailbox: mailbox ?? "",
    account: account ?? "",
    snippet: snippet ?? "",
  }));
}

export function parseMailboxes(out: string): Mailbox[] {
  return records(out).map(([account, emails, name]) => ({
    account: account ?? "",
    emails: emails ? emails.split(", ").filter((e) => e.length > 0) : [],
    name: name ?? "",
  }));
}

export function parseDetail(out: string): { subject: string; from: string; date: string; body: string } {
  const [subject = "", from = "", date = "", body = ""] = out.split(US);
  return { subject, from, date, body };
}
