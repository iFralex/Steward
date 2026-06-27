import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Mailbox,
  MessageSummary,
  ReadArgs,
  ReplyArgs,
  SaveAttachmentArgs,
  SearchArgs,
  SendArgs,
} from "./types.ts";
import { assertEmails, assertSafeDestPath, isEmail } from "./validate.ts";
import { runOsa } from "./osascript.ts";
import {
  mailboxesScript,
  replyScript,
  saveAttachmentScript,
  sendScript,
} from "./applescript.ts";
import { parseMailboxes } from "./parse.ts";
import type { Store } from "../../mail-mirror/src/store.ts";
import { searchDb, type SearchDbArgs } from "./db-search.ts";
import { readDb, type MailDetail } from "./db-read.ts";
import { getThread } from "./db-thread.ts";

type Runner = (script: string, timeoutMs?: number) => Promise<string>;

function toEpochSeconds(s?: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

/** Reading a message body waits on a server download — allow longer. */
const READ_TIMEOUT_MS = 90_000;
/** Sending/replying goes through Mail + the mail server (Exchange round-trip) — allow longer. */
const WRITE_TIMEOUT_MS = 300_000;

export interface MailDeps {
  store: Store;
  embedQuery?: (text: string) => Promise<number[] | null>;
  runner?: Runner;
}

export class Mail {
  private readonly store: Store;
  private readonly embedQuery?: (text: string) => Promise<number[] | null>;
  private readonly run: Runner;

  constructor(deps: MailDeps) {
    this.store = deps.store;
    this.embedQuery = deps.embedQuery;
    this.run = deps.runner ?? ((script, timeoutMs) => runOsa(script, { timeoutMs }));
  }

  async listMailboxes(): Promise<Mailbox[]> {
    return parseMailboxes(await this.run(mailboxesScript()));
  }

  async search(args: SearchArgs): Promise<MessageSummary[]> {
    const dbArgs: SearchDbArgs = {
      query: args.query,
      account: args.account,
      mailbox: args.mailbox,
      anyMailbox: args.anyMailbox,
      subject: args.subject,
      sender: args.sender,
      recipient: args.recipient,
      cc: args.cc,
      senderDomain: args.senderDomain,
      dateFrom: toEpochSeconds(args.dateFrom),
      dateTo: toEpochSeconds(args.dateTo),
      unreadOnly: args.unreadOnly,
      flaggedOnly: args.flaggedOnly,
      answeredOnly: args.answeredOnly,
      junkOnly: args.junkOnly,
      hasAttachments: args.hasAttachments,
      attachmentType: args.attachmentType,
      attachmentName: args.attachmentName,
      minSize: args.minSize,
      maxSize: args.maxSize,
      fromName: args.fromName,
      fromAddr: args.fromAddr,
      toName: args.toName,
      subjectContains: args.subjectContains,
      bodyContains: args.bodyContains,
      sort: args.sort,
      sortDir: args.sortDir,
      limit: args.limit,
      offset: args.offset,
      perMessage: undefined,
    };
    return searchDb(this.store, dbArgs, this.embedQuery);
  }

  async read(args: ReadArgs): Promise<MailDetail> {
    return readDb(this.store, args, (script) => this.run(script, READ_TIMEOUT_MS));
  }

  async saveAttachment(args: SaveAttachmentArgs): Promise<{ path: string }> {
    const dir = args.destDir ? assertSafeDestPath(args.destDir) : tmpdir();
    const name = typeof args.attachment === "string" ? args.attachment : `attachment-${args.attachment}`;
    const dest = join(dir, name);
    await this.run(saveAttachmentScript(args, args.attachment, dest), READ_TIMEOUT_MS);
    return { path: dest };
  }

  async send(args: SendArgs): Promise<{ sent: true }> {
    if (args.from && !isEmail(args.from)) {
      throw new Error(`from: must be one of your account email addresses, got "${args.from}"`);
    }
    assertEmails(args.to, "to");
    if (args.cc?.length) assertEmails(args.cc, "cc");
    if (args.bcc?.length) assertEmails(args.bcc, "bcc");
    await this.run(sendScript(args), WRITE_TIMEOUT_MS);
    return { sent: true };
  }

  async reply(args: ReplyArgs): Promise<{ sent: true }> {
    if (!args.body?.trim()) {
      throw new Error("reply body must not be empty");
    }
    await this.run(replyScript(args), WRITE_TIMEOUT_MS);
    return { sent: true };
  }

  async getThread(args: { threadId?: number; id?: string; messageId?: string }): Promise<MessageSummary[]> {
    return getThread(this.store, args);
  }
}
