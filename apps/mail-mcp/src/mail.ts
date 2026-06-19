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

type Runner = (script: string, timeoutMs?: number) => Promise<string>;

function toEpochSeconds(s?: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

/** Reading a message body waits on a server download — allow longer. */
const READ_TIMEOUT_MS = 90_000;

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
      subject: args.subject,
      sender: args.sender,
      recipient: args.recipient,
      dateFrom: toEpochSeconds(args.dateFrom),
      dateTo: toEpochSeconds(args.dateTo),
      unreadOnly: args.unreadOnly,
      flaggedOnly: args.flaggedOnly,
      hasAttachments: args.hasAttachments,
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
    await this.run(sendScript(args));
    return { sent: true };
  }

  async reply(args: ReplyArgs): Promise<{ sent: true }> {
    await this.run(replyScript(args));
    return { sent: true };
  }
}
