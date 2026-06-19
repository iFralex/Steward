export interface ParsedAttachment {
  filename: string;
  mime: string;
  size: number;
  content: Buffer;
}

export interface ParsedMessage {
  messageId: string; // normalised, no angle brackets; "" if the header was absent
  fromName: string;
  fromAddr: string;
  to: string[];
  cc: string[];
  toNames: string[];
  ccNames: string[];
  subject: string;
  date: number; // epoch seconds
  bodyText: string;
  inReplyTo: string | null; // normalised
  references: string[]; // normalised
  gmThrid: string | null;
  flags: { read: boolean; answered: boolean; flagged: boolean; junk: boolean } | null;
  flagColor: number | null;
  appleThrid: number | null;
  attachments: ParsedAttachment[];
}

/** One on-disk message file discovered by the locator. */
export interface EmlxEntry {
  path: string;
  account: string; // account-UUID dir name
  mailbox: string; // .mbox base name
  isPartial: boolean; // *.partial.emlx
  mtimeMs: number;
}
