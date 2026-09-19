#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { actionDbPath } from "./paths.ts";
import { ActionStore } from "./store.ts";
import { embedFlowText, flowEmbeddingText } from "./flows.ts";
import type { ActionItem, ActionKind, ActionStatus, UpsertFlow } from "./types.ts";

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
          hideExpired: {
            type: "boolean",
            description: "When true, omit items whose dueAt is earlier than now. Items without a due date remain visible.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of actions to return (default 20, hard limit 100).",
          },
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
    {
      name: "list_flows",
      description: "List reusable user-authored workflows. These are persistent preferences used when planning future Actions.",
      inputSchema: { type: "object", properties: { enabledOnly: { type: "boolean" }, limit: { type: "number" } }, additionalProperties: false },
    },
    {
      name: "search_flows",
      description: "Search reusable workflows by a situation description. Read-only; returns at most two matching flows.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    },
    {
      name: "create_flow",
      description: "Create a persistent reusable workflow only when the user explicitly asks to save/create one. This write requires approval; show the dedicated editable flow card.",
      inputSchema: { type: "object", properties: flowProperties(), required: ["name", "when", "guidance"], additionalProperties: false },
    },
    {
      name: "update_flow",
      description: "Replace an existing reusable workflow after reading it first. Send every field so the dedicated approval card is complete and editable. This write requires approval.",
      inputSchema: { type: "object", properties: { id: { type: "number" }, ...flowProperties() }, required: ["id", "name", "when", "guidance", "exclusions", "enabled"], additionalProperties: false },
    },
    {
      name: "set_flow_enabled",
      description: "Enable or disable a reusable workflow without deleting it. This write requires approval.",
      inputSchema: { type: "object", properties: { id: { type: "number" }, enabled: { type: "boolean" } }, required: ["id", "enabled"], additionalProperties: false },
    },
    {
      name: "delete_flow",
      description: "Permanently delete a reusable workflow. This write requires approval.",
      inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"], additionalProperties: false },
    },
  ],
}));

function flowProperties() {
  return {
    name: { type: "string", description: "Short recognizable name." },
    when: { type: "string", description: "Concrete situation in which this flow is relevant; include discriminating signals, not a single example." },
    guidance: { type: "string", description: "Desired sequence/outcome in plain editable text. It may mix tool-backed and manual steps." },
    exclusions: { type: "string", description: "Cases where the flow must not be applied, or empty when none are known." },
    enabled: { type: "boolean", description: "Whether planners may retrieve it. Defaults to true." },
  };
}

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
        const limit = boundedLimit(args.limit, 20);
        const includeDone = status === "all";
        const hideExpired = args.hideExpired === true;
        const items = status === "open" || status === "all"
          ? store.list({ includeDone, hideExpired, kind, limit })
          : store.list({ status: status as ActionStatus, hideExpired, kind, limit });
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
      case "list_flows":
        return text(store.listFlows({ enabledOnly: args.enabledOnly === true, limit: numberArg(args.limit, 50) }));
      case "search_flows": {
        const query = requiredString(args.query, "query");
        return text(store.searchFlows(query, await embedFlowText(query), 2));
      }
      case "create_flow": {
        const input = flowInput(args, false);
        const embedding = await embedFlowText(flowEmbeddingText(input), "flow-index");
        return text({ ok: true, flow: store.createFlow(input, embedding) });
      }
      case "update_flow": {
        const id = safeId(args.id);
        const current = store.getFlow(id);
        if (!current) throw new Error(`flow ${id} not found`);
        const input = flowInput(args, true);
        const next = { ...current, ...input };
        const semanticChanged = input.name !== undefined || input.when !== undefined;
        const embedding = semanticChanged ? await embedFlowText(flowEmbeddingText(next), "flow-index") : undefined;
        return text({ ok: true, flow: store.updateFlow(id, input, embedding) });
      }
      case "set_flow_enabled": {
        const id = safeId(args.id);
        if (typeof args.enabled !== "boolean") throw new Error("enabled must be a boolean");
        return text({ ok: true, flow: store.setFlowEnabled(id, args.enabled) });
      }
      case "delete_flow":
        return text({ ok: store.deleteFlow(safeId(args.id)) });
      default:
        throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${req.params.name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
  }
});

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function safeId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("id must be a positive integer");
  return id;
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function flowInput(args: Record<string, unknown>, partial: false): UpsertFlow;
function flowInput(args: Record<string, unknown>, partial: true): Partial<UpsertFlow>;
function flowInput(args: Record<string, unknown>, partial: boolean): UpsertFlow | Partial<UpsertFlow> {
  const out: Partial<UpsertFlow> = {};
  for (const key of ["name", "when", "guidance", "exclusions"] as const) {
    if (typeof args[key] === "string") out[key] = args[key] as never;
  }
  if (typeof args.enabled === "boolean") out.enabled = args.enabled;
  if (!partial) {
    out.name = requiredString(args.name, "name");
    out.when = requiredString(args.when, "when");
    out.guidance = requiredString(args.guidance, "guidance");
  }
  return out;
}

process.on("SIGTERM", () => { store.close(); process.exit(0); });
process.on("SIGINT", () => { store.close(); process.exit(0); });

await server.connect(new StdioServerTransport());
