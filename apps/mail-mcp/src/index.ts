#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Mail } from "./mail.ts";
import type { ReplyArgs, SaveAttachmentArgs, SearchArgs, SendArgs } from "./types.ts";

const mail = new Mail();
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
        "Search mail across any mailbox/account (Inbox, Sent, Drafts, …). All filters optional and combined with AND.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text in subject or body" },
          subject: { type: "string" },
          sender: { type: "string" },
          recipient: { type: "string" },
          account: { type: "string" },
          mailbox: { type: "string", description: "e.g. Sent, Drafts" },
          dateFrom: { type: "string" },
          dateTo: { type: "string" },
          unreadOnly: { type: "boolean" },
          flaggedOnly: { type: "boolean" },
          hasAttachments: { type: "boolean" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "read_message",
      description: "Read a message's body and attachment list by its Message-ID.",
      inputSchema: {
        type: "object",
        properties: { messageId: { type: "string" } },
        required: ["messageId"],
        additionalProperties: false,
      },
    },
    {
      name: "save_attachment",
      description: "Save a message attachment to disk; returns its path.",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string" },
          attachment: { type: ["string", "number"], description: "attachment name or 1-based index" },
          destDir: { type: "string", description: "absolute dir; defaults to a temp dir" },
        },
        required: ["messageId", "attachment"],
        additionalProperties: false,
      },
    },
    {
      name: "send_email",
      description: "SEND an email (requires the user's approval in the host). Plain-text body.",
      inputSchema: {
        type: "object",
        properties: {
          to: STRINGS("recipient addresses"),
          cc: STRINGS("cc addresses"),
          bcc: STRINGS("bcc addresses"),
          subject: { type: "string" },
          body: { type: "string" },
          attachments: STRINGS("absolute file paths to attach"),
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "reply",
      description: "SEND a reply on a message's thread (requires the user's approval).",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string" },
          body: { type: "string" },
          attachments: STRINGS("absolute file paths to attach"),
          replyAll: { type: "boolean" },
        },
        required: ["messageId", "body"],
        additionalProperties: false,
      },
    },
  ],
}));

function text(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "list_mailboxes":
        return text(await mail.listMailboxes());
      case "search_messages":
        return text(await mail.search(args as SearchArgs));
      case "read_message":
        return text(await mail.read({ messageId: String(args.messageId) }));
      case "save_attachment":
        return text(await mail.saveAttachment(args as unknown as SaveAttachmentArgs));
      case "send_email":
        return text(await mail.send(args as unknown as SendArgs));
      case "reply":
        return text(await mail.reply(args as unknown as ReplyArgs));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
  }
});

await server.connect(new StdioServerTransport());
