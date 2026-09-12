export interface MessageSummary {
  /**
   * Mail.app's native numeric id (as a string). Indexed → fast to look up
   * (`whose id is`). Pass this back to read_message/reply/save_attachment.
   */
  id: string;
  /** RFC 5322 Message-ID header. Stable across sessions but NOT indexed (slow lookup). */
  messageId: string;
  subject: string;
  from: string;
  date: string;
  mailbox: string;
  account: string;
  snippet: string;
  threadId?: number;
  /** Apple Mail deep link — clicking it opens the message in Mail.app. */
  mailUrl: string;
}

/**
 * How to locate a single message. Prefer `id` (Mail's native numeric id from
 * a search result) — it is indexed and fast. `messageId` (RFC) is a slow
 * fallback used only when a native id is not available.
 */
export interface MessageRef {
  id?: string;
  messageId?: string;
}

export interface MessageDetail extends MessageSummary {
  to: string[];
  cc: string[];
  body: string;
  attachments: { name: string; index: number }[];
}

export interface Mailbox {
  account: string;
  /** Email address(es) configured for this account — lets the agent map an address to its account. */
  emails: string[];
  name: string;
}

export interface SearchArgs {
  query?: string;
  subject?: string;
  sender?: string;
  recipient?: string;
  cc?: string;
  senderDomain?: string;
  account?: string;
  mailbox?: string;
  anyMailbox?: boolean;
  dateFrom?: string;
  dateTo?: string;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  answeredOnly?: boolean;
  junkOnly?: boolean;
  hasAttachments?: boolean;
  attachmentType?: string;
  attachmentName?: string;
  minSize?: number;
  maxSize?: number;
  fromName?: string;
  fromAddr?: string;
  toName?: string;
  subjectContains?: string;
  bodyContains?: string;
  sort?: "date" | "size";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  perMessage?: boolean;
}

export interface ReadArgs extends MessageRef {}

export interface SaveAttachmentArgs extends MessageRef {
  attachment: string | number;
  destDir?: string;
}

export interface SendArgs {
  /** Sender address — must be one of your account email addresses. Defaults to Mail's default account. */
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: string[];
  /** ISO 8601 time to send later. Omit to send immediately. */
  sendAt?: string;
}

export interface ReplyArgs extends MessageRef {
  /** Sender address — must be one of your account email addresses. Defaults to Mail's reply-selected account. */
  from?: string;
  body: string;
  attachments?: string[];
  replyAll?: boolean;
  /** ISO 8601 time to send later. Omit to send immediately. */
  sendAt?: string;
}
