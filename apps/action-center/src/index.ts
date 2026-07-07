#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { actionDbPath } from "./paths.ts";
import { ActionStore } from "./store.ts";
import type { ActionItem, ActionKind, ActionStatus } from "./types.ts";

const store = ActionStore.open(actionDbPath());
const server = new Server({ name: "action-center", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_actions",
      description: "List current action-center items: reply-needed mail, scheduling requests, reminders, deadlines, and proposed plans. Returns lightweight summaries only (no contextSnapshot/proposedActions) — use read_action to drill into one item's full detail.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["open", "new", "read", "done", "dismissed", "all"],
            description: "Defaults to 'open' (status new or read — items still to do). 'all' includes done/dismissed too.",
          },
          kind: {
            type: "string",
            enum: ["reply-needed", "scheduling-request", "calendar-invite", "event-reminder", "deadline", "document-action", "follow-up", "admin-task"],
            description: "Optional: only items of this kind.",
          },
          limit: { type: "number" },
          includePayload: {
            type: "boolean",
            description: "Include each item's full contextSnapshot/proposedActions payload (large — tens of KB per item). Defaults to false; prefer read_action for a single item's detail instead.",
          },
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

/** Drop the (potentially tens-of-KB) payload for list views — read_action fetches it for one item. */
function omitPayload(item: ActionItem): Omit<ActionItem, "payload"> {
  const { payload: _payload, ...rest } = item;
  return rest;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "list_actions": {
        const status = typeof args.status === "string" ? args.status : "open";
        const kind = typeof args.kind === "string" ? (args.kind as ActionKind) : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 20;
        const includeDone = status === "all";
        const items = status === "open" || status === "all"
          ? store.list({ includeDone, kind, limit })
          : store.list({ status: status as ActionStatus, kind, limit });
        const includePayload = args.includePayload === true;
        return text(includePayload ? items : items.map(omitPayload));
      }
      case "read_action": {
        const id = Number(args.id);
        if (!Number.isSafeInteger(id)) throw new Error("id must be a number");
        return text(store.get(id));
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
