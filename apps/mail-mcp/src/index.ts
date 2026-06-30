#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Store } from "../../mail-mirror/src/store.ts";
import { dbPath } from "../../mail-mirror/src/paths.ts";
import { loadEmbedConfig } from "../../mail-mirror/src/embed-config.ts";
import { embedText } from "../../mail-mirror/src/embed-client.ts";
import { Mail } from "./mail.ts";
import type { ReadArgs, ReplyArgs, SaveAttachmentArgs, SearchArgs, SendArgs } from "./types.ts";
import { enrichmentReady } from "./capabilities.ts";
import { usesAdvancedFilters } from "./advanced-args.ts";
import { WriteOpsStore } from "@llm-wiki/write-ops";

// Open the read-only Store once at startup if the DB exists.
// send/reply/listMailboxes/saveAttachment are AppleScript-backed and work without it.
// search/read require the DB and return an actionable message when it is absent or empty.
const path = dbPath();
const dbReady = existsSync(path);
const store = dbReady ? Store.openReadonly(path) : Store.open(":memory:");
if (dbReady) store.enableVectors();
const enriched = dbReady && enrichmentReady(store);

const embedCfg = loadEmbedConfig();
const embedQuery = embedCfg ? (text: string) => embedText(text, embedCfg) : undefined;

const writeOps = WriteOpsStore.open();
const mail = new Mail({ store, embedQuery, writeOps });

// Warm the cold paths once at startup so the first real query isn't slow: the
// knn over the (~280MB) vector table and the trigram index each pay a one-time
// cold-cache cost (measured ~8s for the first semantic search). Fire-and-forget.
if (dbReady) {
  void (async () => {
    try {
      const dim = Number(store.getState("vec_dim") ?? 0);
      if (dim > 0) store.knn(new Array(dim).fill(0), 1);
      store.searchTrig("from_name", "warmup", 1);
    } catch { /* best-effort warm-up */ }
  })();
}

const server = new Server({ name: "mail", version: "0.0.0" }, { capabilities: { tools: {} } });

const STRINGS = (description: string) => ({ type: "array", items: { type: "string" }, description });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_mailboxes",
      description: "List all mailboxes across all Mail accounts (Inbox, Sent, Drafts, …).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "search_messages",
      description:
        "Search mail across any mailbox/account (Inbox, Sent, Drafts, …). All filters optional and combined with AND. Advanced filters (toName, fromName, fromAddr, subjectContains, bodyContains, cc, senderDomain, attachmentType, attachmentName, minSize, maxSize, answeredOnly, junkOnly, sort) require `mail-mirror migrate` to have run once.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text in subject or body" },
          subject: { type: "string" },
          sender: { type: "string" },
          recipient: { type: "string" },
          cc: { type: "string", description: "Substring match against CC addresses or names" },
          senderDomain: { type: "string", description: "Match sender's email domain (e.g. gmail.com)" },
          account: { type: "string", description: "account email, name, or UUID" },
          mailbox: {
            type: "string",
            description: "mailbox name or role keyword (inbox, drafts, sent, trash, junk, archive, important, flagged); use anyMailbox to match a message in ANY of its mailboxes",
          },
          anyMailbox: { type: "boolean", description: "When true, match if the message appears in any of the resolved mailboxes" },
          dateFrom: { type: "string" },
          dateTo: { type: "string" },
          unreadOnly: { type: "boolean" },
          flaggedOnly: { type: "boolean" },
          answeredOnly: { type: "boolean", description: "Only messages that have been replied to" },
          junkOnly: { type: "boolean", description: "Only messages marked as junk/spam" },
          hasAttachments: { type: "boolean" },
          attachmentType: { type: "string", description: "Substring match against attachment MIME type or file extension" },
          attachmentName: { type: "string", description: "Substring match against attachment filename" },
          minSize: { type: "number", description: "Minimum message size in bytes" },
          maxSize: { type: "number", description: "Maximum message size in bytes" },
          fromName: { type: "string", description: "Substring match against sender display name" },
          fromAddr: { type: "string", description: "Substring match against sender email address" },
          toName: { type: "string", description: "Substring match against recipient display name" },
          subjectContains: { type: "string", description: "Substring match against subject (trigram)" },
          bodyContains: { type: "string", description: "Substring match against body text (trigram)" },
          sort: { type: "string", enum: ["date", "size"], description: "Sort field (default: date)" },
          sortDir: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default: desc)" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "read_message",
      description: "Read a message body and attachment list. Pass the `messageId` from a search_messages result. Results include `mailUrl`, a clickable Apple Mail deep link (message://…) that opens the message in Mail — useful e.g. in a calendar event's url/description.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "the message's `id` from a search result — pass it back as-is" },
          messageId: { type: "string", description: "RFC Message-ID — alternative to `id`" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "save_attachment",
      description: "Save a message attachment to disk; returns its path.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "the message's `id` from a search result — pass it back as-is" },
          messageId: { type: "string", description: "RFC Message-ID — alternative to `id`" },
          attachment: { type: ["string", "number"], description: "attachment name or 1-based index" },
          destDir: { type: "string", description: "absolute dir; defaults to a temp dir" },
        },
        required: ["attachment"],
        additionalProperties: false,
      },
    },
    {
      name: "send_email",
      description: "SEND an email (requires the user approval in the host). Plain-text body.",
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "sender address; must be one of your account emails (see list_mailboxes). Omit to use Mail default account.",
          },
          to: STRINGS("recipient addresses"),
          cc: STRINGS("cc addresses"),
          bcc: STRINGS("bcc addresses"),
          subject: { type: "string" },
          body: { type: "string", minLength: 1 },
          attachments: STRINGS("absolute file paths to attach"),
          sendAt: { type: "string", description: "ISO 8601 time to send later (e.g. 2026-07-01T09:00:00+02:00). Omit to send now." },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "reply",
      description: "SEND a reply on a message thread (requires the user approval).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "the message's `id` from a search result — pass it back as-is" },
          messageId: { type: "string", description: "RFC Message-ID — alternative to `id`" },
          from: {
            type: "string",
            description: "sender address; must be one of your account emails (see list_mailboxes). Omit to let Mail choose the reply account.",
          },
          body: { type: "string", minLength: 1 },
          attachments: STRINGS("absolute file paths to attach"),
          replyAll: { type: "boolean" },
          sendAt: { type: "string", description: "ISO 8601 time to send later. Omit to send now." },
        },
        required: ["body"],
        additionalProperties: false,
      },
    },
    {
      name: "list_scheduled",
      description: "List emails queued for later delivery (scheduled send/reply not yet sent).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "cancel_scheduled",
      description: "Cancel a scheduled send/reply before it fires. Pass the operationId from the scheduled receipt or list_scheduled.",
      inputSchema: {
        type: "object",
        properties: { operationId: { type: "string" } },
        required: ["operationId"],
        additionalProperties: false,
      },
    },
    {
      name: "get_thread",
      description: "Return every message in a conversation, oldest first. Pass a threadId from a search result, or a message id/messageId.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "number" },
          id: { type: "string", description: "Mail native id from a search result" },
          messageId: { type: "string", description: "RFC Message-ID" },
        },
        additionalProperties: false,
      },
    },
  ],
}));

function text(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function dbEmptyCheck(): { empty: boolean; message: string } {
  if (!dbReady) {
    return { empty: true, message: "Mail mirror not found. Run: mail-mirror backfill" };
  }
  const total = (store.raw.prepare("SELECT COUNT(*) c FROM messages WHERE deleted=0").get() as { c: number }).c;
  if (total === 0) {
    return { empty: true, message: "Mail mirror is empty. Run: mail-mirror backfill" };
  }
  return { empty: false, message: "" };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "list_mailboxes":
        return text(await mail.listMailboxes());
      case "search_messages": {
        const check = dbEmptyCheck();
        if (check.empty) return text({ error: check.message });
        if (!enriched && usesAdvancedFilters(args as SearchArgs)) {
          return text({ error: "Advanced filters (account/role, flags, attachments, size, sort, field-scoped) require the enriched mirror. Run: mail-mirror migrate" });
        }
        return text(await mail.search(args as SearchArgs));
      }
      case "read_message": {
        const check = dbEmptyCheck();
        if (check.empty) return text({ error: check.message });
        return text(await mail.read(args as ReadArgs));
      }
      case "save_attachment":
        return text(await mail.saveAttachment(args as unknown as SaveAttachmentArgs));
      case "send_email":
        return text(await mail.send(args as unknown as SendArgs));
      case "reply":
        return text(await mail.reply(args as unknown as ReplyArgs));
      case "list_scheduled":
        return text(writeOps.listScheduled().map((o) => ({
          operationId: o.id,
          kind: o.kind,
          sendAt: o.scheduledFor ? new Date(o.scheduledFor * 1000).toISOString() : null,
          to: o.input.to ?? null,
          subject: o.input.subject ?? null,
          bodySnippet: o.expected.bodySnippet ?? null,
        })));
      case "cancel_scheduled":
        return text({ cancelled: writeOps.cancelScheduled(String((args as { operationId?: unknown }).operationId ?? "")) });
      case "get_thread": {
        const check = dbEmptyCheck();
        if (check.empty) return text({ error: check.message });
        return text(await mail.getThread(args as { threadId?: number; id?: string; messageId?: string }));
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
  }
});

await server.connect(new StdioServerTransport());
