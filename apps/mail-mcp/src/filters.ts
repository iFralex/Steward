export interface DbFilters {
  account?: string;
  mailbox?: string;
  sender?: string;
  recipient?: string;
  dateFrom?: number;
  dateTo?: number;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  hasAttachments?: boolean;
}

export function buildFilterSql(f: DbFilters): { clause: string; params: unknown[] } {
  const conds: string[] = ["m.deleted=0"];
  const params: unknown[] = [];
  if (f.account) { conds.push("m.account=?"); params.push(f.account); }
  if (f.mailbox) { conds.push("m.mailbox=?"); params.push(f.mailbox); }
  if (f.sender) { conds.push("(m.from_addr LIKE ? OR m.from_name LIKE ?)"); params.push(`%${f.sender}%`, `%${f.sender}%`); }
  if (f.recipient) { conds.push("m.to_addrs LIKE ?"); params.push(`%${f.recipient}%`); }
  if (typeof f.dateFrom === "number") { conds.push("m.date>=?"); params.push(f.dateFrom); }
  if (typeof f.dateTo === "number") { conds.push("m.date<=?"); params.push(f.dateTo); }
  if (f.unreadOnly) conds.push("m.unread=1");
  if (f.flaggedOnly) conds.push("m.flagged=1");
  if (f.hasAttachments) conds.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.message_id)");
  return { clause: conds.join(" AND "), params };
}
