export interface MessageSummary {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  mailbox: string;
  account: string;
  snippet: string;
}

export interface MessageDetail extends MessageSummary {
  to: string[];
  cc: string[];
  body: string;
  attachments: { name: string; index: number }[];
}

export interface Mailbox {
  account: string;
  name: string;
}

export interface SearchArgs {
  query?: string;
  subject?: string;
  sender?: string;
  recipient?: string;
  account?: string;
  mailbox?: string;
  dateFrom?: string;
  dateTo?: string;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  hasAttachments?: boolean;
  limit?: number;
  offset?: number;
}

export interface ReadArgs {
  messageId: string;
}

export interface SaveAttachmentArgs {
  messageId: string;
  attachment: string | number;
  destDir?: string;
}

export interface SendArgs {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: string[];
}

export interface ReplyArgs {
  messageId: string;
  body: string;
  attachments?: string[];
  replyAll?: boolean;
}
