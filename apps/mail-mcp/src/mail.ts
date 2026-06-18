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
import { assertEmails, assertSafeDestPath } from "./validate.ts";
import { runOsa } from "./osascript.ts";
import {
  mailboxesScript,
  readScript,
  replyScript,
  saveAttachmentScript,
  searchScript,
  sendScript,
} from "./applescript.ts";
import { parseDetail, parseMailboxes, parseSummaries } from "./parse.ts";

type Runner = (script: string) => Promise<string>;

export class Mail {
  private readonly run: Runner;

  constructor(runner?: Runner) {
    this.run = runner ?? ((script) => runOsa(script));
  }

  async listMailboxes(): Promise<Mailbox[]> {
    return parseMailboxes(await this.run(mailboxesScript()));
  }

  async search(args: SearchArgs): Promise<MessageSummary[]> {
    let rows = parseSummaries(await this.run(searchScript(args)));
    // Costly filters applied post-hoc (see spec). subject/sender/flags are
    // handled in-script; body-`query`/recipient/date/hasAttachments are
    // refined against real Mail.app — `query` matches the subject here.
    if (args.query) {
      const q = args.query.toLowerCase();
      rows = rows.filter((r) => r.subject.toLowerCase().includes(q));
    }
    return rows;
  }

  async read(args: ReadArgs): Promise<{ subject: string; from: string; date: string; body: string }> {
    return parseDetail(await this.run(readScript(args.messageId)));
  }

  async saveAttachment(args: SaveAttachmentArgs): Promise<{ path: string }> {
    const dir = args.destDir ? assertSafeDestPath(args.destDir) : tmpdir();
    const name = typeof args.attachment === "string" ? args.attachment : `attachment-${args.attachment}`;
    const dest = join(dir, name);
    await this.run(saveAttachmentScript(args.messageId, args.attachment, dest));
    return { path: dest };
  }

  async send(args: SendArgs): Promise<{ sent: true }> {
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
