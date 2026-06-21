#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AppleStore } from "./apple-store.ts";
import { IndexDb } from "./index-db.ts";
import { hybridSearch } from "./search.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { embedText } from "@llm-wiki/search";
import { createEvent, updateEvent, deleteEvent } from "./applescript.ts";
import { parseSearchArgs, parseCreateArgs, parseUpdateArgs, requireString } from "./args.ts";
import { applePath, indexDbPath } from "./paths.ts";

const appleReady = existsSync(applePath());
const store = appleReady ? AppleStore.openReadonly(applePath()) : null;
const idxReady = existsSync(indexDbPath());
const index = idxReady ? IndexDb.open(indexDbPath()) : null;
if (index) index.vectors.enable();
const embedCfg = loadEmbedConfig();
const embedQuery = embedCfg ? (t: string) => embedText(t, embedCfg) : undefined;

const server = new Server({ name: "calendar", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "list_calendars", description: "List calendars with their account.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "search_events", description: "Search events (hybrid keyword+semantic). All filters optional and ANDed.", inputSchema: { type: "object", properties: {
      query: { type: "string" }, start: { type: "string", description: "ISO start of range" }, end: { type: "string", description: "ISO end of range" },
      account: { type: "string" }, calendar: { type: "string" }, limit: { type: "number" } }, additionalProperties: false } },
    { name: "read_event", description: "Read one event by uid.", inputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"], additionalProperties: false } },
    { name: "create_event", description: "Create a calendar event.", inputSchema: { type: "object", properties: {
      calendar: { type: "string" }, summary: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      allDay: { type: "boolean" }, location: { type: "string" }, description: { type: "string" }, url: { type: "string" }, recurrence: { type: "string" } },
      required: ["calendar", "summary", "start", "end"], additionalProperties: false } },
    { name: "update_event", description: "Update fields of an event by uid.", inputSchema: { type: "object", properties: {
      uid: { type: "string" }, summary: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      location: { type: "string" }, description: { type: "string" }, url: { type: "string" }, recurrence: { type: "string" } },
      required: ["uid"], additionalProperties: false } },
    { name: "delete_event", description: "Delete an event by uid.", inputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"], additionalProperties: false } },
  ],
}));

function ok(data: unknown) { return { content: [{ type: "text", text: JSON.stringify(data) }] }; }

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const raw = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "list_calendars": {
        if (!store) throw new Error("Apple Calendar store not found. Grant Full Disk Access.");
        return ok(store.listCalendars());
      }
      case "search_events": {
        if (!store) throw new Error("Apple Calendar store not found. Grant Full Disk Access.");
        const a = parseSearchArgs(raw);
        let uids: string[];
        if (a.query && index) uids = await hybridSearch({ index, embedQuery }, a.query, a.limit);
        else uids = store.eventsInRange({ startISO: a.start, endISO: a.end, account: a.account, calendar: a.calendar }).map((e) => e.uid);
        const events = uids.map((u) => store.getEvent(u)).filter(Boolean)
          .filter((e) => (!a.account || e!.account === a.account) && (!a.calendar || e!.calendar === a.calendar))
          .slice(0, a.limit);
        return ok(events);
      }
      case "read_event": {
        if (!store) throw new Error("Apple Calendar store not found. Grant Full Disk Access.");
        return ok(store.getEvent(requireString(raw, "uid")) ?? null);
      }
      case "create_event": return ok({ uid: await createEvent(parseCreateArgs(raw)) });
      case "update_event": { await updateEvent(parseUpdateArgs(raw)); return ok({ ok: true }); }
      case "delete_event": { await deleteEvent(requireString(raw, "uid")); return ok({ ok: true }); }
      default: throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${req.params.name}`);
    }
  } catch (e) {
    throw new McpError(ErrorCode.InternalError, e instanceof Error ? e.message : String(e));
  }
});

await server.connect(new StdioServerTransport());
