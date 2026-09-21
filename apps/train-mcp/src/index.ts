#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ViaggiaTrenoClient } from "./client.ts";
import { AmbiguousStationError, TrainService } from "./service.ts";

const server = new Server({ name: "trains", version: "0.0.0" }, { capabilities: { tools: {} } });
const service = new TrainService(new ViaggiaTrenoClient());

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  {
    name: "find_next_train",
    description: "Find the next DIRECT live train between two Italian stations. Returns a trainRef, scheduled/estimated times, delay, cancellation state, and departure platform explicitly marked confirmed, scheduled-only, or unknown. Never describe a scheduled-only platform as confirmed. This uses the current ViaggiaTreno departure-board window and does not plan connections.",
    inputSchema: { type: "object", properties: {
      from: { type: "string", description: "Exact departure station name, e.g. Milano Centrale." },
      to: { type: "string", description: "Exact arrival station name, e.g. Bologna Centrale." },
      departureAfter: { type: "string", description: "Optional ISO 8601 date-time with timezone; defaults to now." },
    }, required: ["from", "to"], additionalProperties: false },
  },
  {
    name: "train_status",
    description: "Refresh live status, delay, route and platform for a trainRef previously returned by find_next_train. State whether the platform is confirmed, scheduled-only, or not yet communicated and include lastUpdated.",
    inputSchema: { type: "object", properties: { trainRef: { type: "string" } }, required: ["trainRef"], additionalProperties: false },
  },
  {
    name: "retarget_train",
    description: "Follow the same physical train run to a different downstream station, including after departure. Use this before creating a watcher for a named station that differs from the current trainRef destination.",
    inputSchema: { type: "object", properties: {
      trainRef: { type: "string" },
      to: { type: "string", description: "Exact downstream station name." },
    }, required: ["trainRef", "to"], additionalProperties: false },
  },
] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (request.params.name) {
      case "find_next_train":
        return json(await service.findNextTrain(required(args, "from"), required(args, "to"), optional(args, "departureAfter")));
      case "train_status":
        return json(await service.status(required(args, "trainRef")));
      case "retarget_train":
        return json(await service.retarget(required(args, "trainRef"), required(args, "to")));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${request.params.name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    if (error instanceof AmbiguousStationError) return json({ error: "ambiguous_station", query: error.query, candidates: error.candidates });
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
  }
});

function required(args: Record<string, unknown>, key: string): string {
  const value = optional(args, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}
function optional(args: Record<string, unknown>, key: string): string | undefined { const value = args[key]; return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function json(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }

await server.connect(new StdioServerTransport());
