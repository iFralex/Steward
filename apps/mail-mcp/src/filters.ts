export interface DbFilters {
  account?: string;
  mailbox?: string;
  mailboxNames?: string[];
  anyMailbox?: boolean;
  subject?: string;
  sender?: string;
  recipient?: string;
  cc?: string;
  senderDomain?: string;
  dateFrom?: number;
  dateTo?: number;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  answeredOnly?: boolean;
  junkOnly?: boolean;
  hasAttachments?: boolean;
  attachmentType?: string;
  attachmentName?: string;
  minSize?: number;
  maxSize?: number;
}

export function buildFilterSql(f: DbFilters): { clause: string; params: unknown[] } {
  const conds: string[] = ["m.deleted=0"];
  const params: unknown[] = [];
  if (f.account) { conds.push("m.account=?"); params.push(f.account); }
  if (f.mailboxNames && f.mailboxNames.length) {
    const ph = f.mailboxNames.map(() => "?").join(",");
    if (f.anyMailbox) {
      conds.push(`EXISTS (SELECT 1 FROM message_paths mp WHERE mp.message_id=m.message_id AND mp.mailbox IN (${ph}))`);
    } else {
      conds.push(`m.mailbox IN (${ph})`);
    }
    params.push(...f.mailboxNames);
  } else if (f.mailbox) { conds.push("m.mailbox=?"); params.push(f.mailbox); }
  if (f.subject) { conds.push("m.subject LIKE ?"); params.push(`%${f.subject}%`); }
  if (f.sender) { conds.push("(m.from_addr LIKE ? OR m.from_name LIKE ?)"); params.push(`%${f.sender}%`, `%${f.sender}%`); }
  if (f.recipient) { conds.push("(m.to_addrs LIKE ? OR m.to_names LIKE ?)"); params.push(`%${f.recipient}%`, `%${f.recipient}%`); }
  if (f.cc) { conds.push("(m.cc_addrs LIKE ? OR m.cc_names LIKE ?)"); params.push(`%${f.cc}%`, `%${f.cc}%`); }
  if (f.senderDomain) { conds.push("m.from_addr LIKE ?"); params.push(`%@${f.senderDomain.replace(/^@/, "")}`); }
  if (typeof f.dateFrom === "number") { conds.push("m.date>=?"); params.push(f.dateFrom); }
  if (typeof f.dateTo === "number") { conds.push("m.date<=?"); params.push(f.dateTo); }
  if (f.unreadOnly) conds.push("m.unread=1");
  if (f.flaggedOnly) conds.push("m.flagged=1");
  if (f.answeredOnly) conds.push("m.answered=1");
  if (f.junkOnly) conds.push("m.junk=1");
  if (typeof f.minSize === "number") { conds.push("m.size>=?"); params.push(f.minSize); }
  if (typeof f.maxSize === "number") { conds.push("m.size<=?"); params.push(f.maxSize); }
  if (f.hasAttachments) conds.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.message_id)");
  if (f.attachmentType) {
    conds.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.message_id AND (a.mime LIKE ? OR a.filename LIKE ?))");
    params.push(`%${f.attachmentType}%`, `%.${f.attachmentType.replace(/^\./, "")}`);
  }
  if (f.attachmentName) {
    conds.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.message_id AND a.filename LIKE ?)");
    params.push(`%${f.attachmentName}%`);
  }
  return { clause: conds.join(" AND "), params };
}
