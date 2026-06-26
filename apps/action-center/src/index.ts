#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { actionDbPath } from "./paths.ts";
import { ActionStore } from "./store.ts";
import type { ActionStatus } from "./types.ts";

const store = ActionStore.open(actionDbPath());
const server = new Server({ name: "action-center", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_actions",
      description: "List current action-center items: reply-needed mail, scheduling requests, reminders, deadlines, and proposed plans.",
      inputSchema: {
        type: "object",
        properties: {
          includeDone: { type: "boolean" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "read_action",
      description: "Read one action-center item with full contextSnapshot and proposedActions. Use this before discussing or executing an action.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "mark_action",
      description: "Mark an action-center item as new/read/done/dismissed after the user handles it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          status: { type: "string", enum: ["new", "read", "done", "dismissed"] },
        },
        required: ["id", "status"],
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
      case "list_actions":
        return text(store.list({
          includeDone: args.includeDone === true,
          limit: typeof args.limit === "number" ? args.limit : 20,
        }));
      case "read_action": {
        const id = Number(args.id);
        if (!Number.isSafeInteger(id)) throw new Error("id must be a number");
        const item = store.list({ includeDone: true, limit: 500 }).find((a) => a.id === id) ?? null;
        return text(item);
      }
      case "mark_action": {
        const id = Number(args.id);
        const status = args.status as ActionStatus;
        if (!Number.isSafeInteger(id) || !["new", "read", "done", "dismissed"].includes(status)) {
          throw new Error("mark_action requires id and status");
        }
        return text({ ok: store.mark(id, status) });
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${req.params.name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
  }
});

process.on("SIGTERM", () => { store.close(); process.exit(0); });
process.on("SIGINT", () => { store.close(); process.exit(0); });

await server.connect(new StdioServerTransport());
