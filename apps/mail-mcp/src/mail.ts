import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { join, basename } from "node:path";
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
import { parseEmlxFile } from "../../mail-mirror/src/emlx.ts";
import { bodySnippet, sha256, WriteOpsStore, type WriteOpKind } from "@llm-wiki/write-ops";

/** Result of a send/reply: sent now, or queued for later delivery. */
type WriteResult = { sent: true; operationId?: string } | { scheduled: true; sendAt: string; operationId: string };

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

let writeLock: Promise<void> = Promise.resolve();

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface MailDeps {
  store: Store;
  embedQuery?: (text: string) => Promise<number[] | null>;
  runner?: Runner;
  writeOps?: WriteOpsStore | null;
}

export class Mail {
  private readonly store: Store;
  private readonly embedQuery?: (text: string) => Promise<number[] | null>;
  private readonly run: Runner;
  private readonly writeOps: WriteOpsStore | null;

  constructor(deps: MailDeps) {
    this.store = deps.store;
    this.embedQuery = deps.embedQuery;
    this.run = deps.runner ?? ((script, timeoutMs) => runOsa(script, { timeoutMs }));
    this.writeOps = deps.writeOps ?? null;
  }

  async listMailboxes(): Promise<Mailbox[]> {
    // Serve from the local mirror (instant) instead of a ~5s live AppleScript
    // enumeration. Falls back to AppleScript only when the mirror is empty
    // (e.g. an in-memory store when the DB file is absent).
    const fromMirror = this.mailboxesFromMirror();
    if (fromMirror.length) return fromMirror;
    return parseMailboxes(await this.run(mailboxesScript()));
  }

  /** Mailboxes that actually hold mail, with each account's name + emails. */
  private mailboxesFromMirror(): Mailbox[] {
    const rows = this.store.raw.prepare(
      `SELECT DISTINCT m.mailbox AS name, COALESCE(a.name, m.account) AS account, a.emails AS emails
       FROM messages m LEFT JOIN accounts a ON a.uuid = m.account
       WHERE m.deleted=0 AND m.mailbox IS NOT NULL AND m.mailbox <> ''
       ORDER BY account, name`,
    ).all() as { name: string; account: string; emails: string | null }[];
    return rows.map((r) => ({
      account: r.account,
      emails: r.emails ? r.emails.split(/,\s*/).filter(Boolean) : [],
      name: r.name,
    }));
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
    // Fast path: extract the attachment from the message's .emlx on disk — no
    // AppleScript, no global message scan (which timed out on large mailboxes).
    const fromMirror = await this.saveAttachmentFromMirror(args, dir);
    if (fromMirror) return fromMirror;
    // Fallback: live AppleScript save (message not mirrored / no .emlx / not found).
    const name = typeof args.attachment === "string" ? args.attachment : `attachment-${args.attachment}`;
    const dest = join(dir, basename(name));
    await this.run(saveAttachmentScript(args, args.attachment, dest), READ_TIMEOUT_MS);
    return { path: dest };
  }

  /** Save an attachment straight from the message's .emlx (decoded by the mirror's parser). */
  private async saveAttachmentFromMirror(args: SaveAttachmentArgs, dir: string): Promise<{ path: string } | null> {
    const messageId = args.messageId ?? args.id;
    if (!messageId) return null;
    const row = this.store.getMessage(messageId);
    if (!row?.emlxPath) return null;
    try {
      const parsed = await parseEmlxFile(row.emlxPath);
      const att = typeof args.attachment === "number"
        ? parsed.attachments[args.attachment - 1]
        : parsed.attachments.find((a) => a.filename === args.attachment);
      if (!att?.content) return null;
      const dest = join(dir, basename(att.filename || `attachment-${args.attachment}`));
      writeFileSync(dest, att.content);
      return { path: dest };
    } catch {
      return null;
    }
  }

  /** If `sendAt` is set, queue the op for later delivery and return the receipt; else undefined. */
  private maybeSchedule(kind: WriteOpKind, args: { sendAt?: string }, input: unknown, expected: Record<string, unknown>): { scheduled: true; sendAt: string; operationId: string } | undefined {
    if (!args.sendAt) return undefined;
    const ts = Date.parse(args.sendAt);
    if (Number.isNaN(ts)) throw new Error(`sendAt must be an ISO 8601 date, got "${args.sendAt}"`);
    if (!this.writeOps) throw new Error("scheduled send is unavailable (write-ops store not configured)");
    const operationId = this.writeOps.startScheduled({ kind, input: input as Record<string, unknown>, expected }, Math.floor(ts / 1000));
    return { scheduled: true, sendAt: new Date(ts).toISOString(), operationId };
  }

  async send(args: SendArgs): Promise<WriteResult> {
    if (args.from && !isEmail(args.from)) {
      throw new Error(`from: not a valid email address: "${args.from}"`);
    }
    assertEmails(args.to, "to");
    if (args.cc?.length) assertEmails(args.cc, "cc");
    if (args.bcc?.length) assertEmails(args.bcc, "bcc");
    const expected = {
      from: args.from ?? null, to: args.to, cc: args.cc ?? [], bcc: args.bcc ?? [],
      subject: args.subject, bodyHash: sha256(args.body), bodySnippet: bodySnippet(args.body),
    };
    const scheduled = this.maybeSchedule("mail.send", args, args, expected);
    if (scheduled) return scheduled;

    const operationId = this.writeOps?.start({ kind: "mail.send", input: args as unknown as Record<string, unknown>, expected });
    try {
      await withWriteLock(() => this.run(sendScript(args), WRITE_TIMEOUT_MS));
      if (operationId) this.writeOps?.scriptReturned(operationId);
      return { sent: true, ...(operationId ? { operationId } : {}) };
    } catch (err) {
      if (operationId) this.writeOps?.failed(operationId, err);
      throw err;
    }
  }

  async reply(args: ReplyArgs): Promise<WriteResult> {
    if (args.from && !isEmail(args.from)) {
      throw new Error(`from: not a valid email address: "${args.from}"`);
    }
    if (!args.body?.trim()) {
      throw new Error("reply body must not be empty");
    }
    const expected = {
      messageId: args.messageId ?? null, id: args.id ?? null, from: args.from ?? null,
      replyAll: args.replyAll ?? false, bodyHash: sha256(args.body), bodySnippet: bodySnippet(args.body),
    };
    const scheduled = this.maybeSchedule("mail.reply", args, args, expected);
    if (scheduled) return scheduled;

    const operationId = this.writeOps?.start({ kind: "mail.reply", input: args as unknown as Record<string, unknown>, expected });
    try {
      await withWriteLock(() => this.run(replyScript(args), WRITE_TIMEOUT_MS));
      if (operationId) this.writeOps?.scriptReturned(operationId);
      return { sent: true, ...(operationId ? { operationId } : {}) };
    } catch (err) {
      if (operationId) this.writeOps?.failed(operationId, err);
      throw err;
    }
  }

  async getThread(args: { threadId?: number; id?: string; messageId?: string }): Promise<MessageSummary[]> {
    return getThread(this.store, args);
  }
}
