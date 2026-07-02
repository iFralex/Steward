#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AppleStore } from "./apple-store.ts";
import { IndexDb } from "./index-db.ts";
import type { CalEvent } from "./types.ts";
import { hybridSearch } from "./search.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { embedText } from "@llm-wiki/search";
import { createEvent, updateEvent, deleteEvent } from "./applescript.ts";
import { parseSearchArgs, parseCreateArgs, parseUpdateArgs, requireString } from "./args.ts";
import { applePath, indexDbPath } from "./paths.ts";
import { WriteOpsStore } from "@llm-wiki/write-ops";

let store: AppleStore | null = null;
let storeError: string | null = null;
try {
  const appleReady = existsSync(applePath());
  store = appleReady ? AppleStore.openReadonly(applePath()) : null;
  if (!store) storeError = "Apple Calendar store not found. Grant Full Disk Access.";
} catch (err) {
  storeError = calendarPermissionError(err);
}

let index: IndexDb | null = null;
try {
  const idxReady = existsSync(indexDbPath());
  index = idxReady ? IndexDb.open(indexDbPath()) : null;
} catch {
  index = null;
}
if (index) index.vectors.enable();
const embedCfg = loadEmbedConfig();
const embedQuery = embedCfg ? (t: string) => embedText(t, embedCfg) : undefined;
const writeOps = WriteOpsStore.open();

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
      allDay: { type: "boolean" }, location: { type: "string" }, description: { type: "string" }, url: { type: "string" }, recurrence: { type: "string" },
      alarms: { type: "array", items: { type: "number" }, description: "alerts in minutes before the event, e.g. [15, 1440] = 15 min + 1 day before" } },
      required: ["calendar", "summary", "start", "end"], additionalProperties: false } },
    { name: "update_event", description: "Update fields of an event by uid.", inputSchema: { type: "object", properties: {
      uid: { type: "string" }, summary: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      location: { type: "string" }, description: { type: "string" }, url: { type: "string" }, recurrence: { type: "string" },
      alarms: { type: "array", items: { type: "number" }, description: "replaces the event's alerts; minutes before start; [] clears all" } },
      required: ["uid"], additionalProperties: false } },
    { name: "delete_event", description: "Delete an event by uid.", inputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"], additionalProperties: false } },
  ],
}));

function ok(data: unknown) { return { content: [{ type: "text", text: JSON.stringify(data) }] }; }

function calendarPermissionError(err?: unknown): string {
  const detail = err instanceof Error ? err.message : err ? String(err) : "";
  return [
    "Apple Calendar store is not readable.",
    "Grant Full Disk Access to LLM Wiki.app in System Settings -> Privacy & Security -> Full Disk Access, then restart LLM Wiki.",
    detail ? `Detail: ${detail}` : "",
  ].filter(Boolean).join(" ");
}

function requireStore(): AppleStore {
  if (!store) throw new Error(storeError ?? calendarPermissionError());
  return store;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const raw = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "list_calendars": {
        return ok(requireStore().listCalendars());
      }
      case "search_events": {
        const liveStore = requireStore();
        const a = parseSearchArgs(raw);
        let uids: string[];
        if (a.query && index) {
          // Keyword/semantic search applies the date window only when the caller
          // gave one explicitly — defaulting it would silently hurt recall.
          const dateExplicit = typeof raw.start === "string" || typeof raw.end === "string";
          uids = await hybridSearch({ index, embedQuery }, a.query, a.limit, {
            account: a.account,
            calendar: a.calendar,
            ...(dateExplicit ? { startISO: a.start, endISO: a.end } : {}),
          });
        } else {
          uids = liveStore.eventsInRange({ startISO: a.start, endISO: a.end, account: a.account, calendar: a.calendar }).map((e) => e.uid);
        }
        // Both paths already applied the account/calendar/date filters; just resolve live detail.
        const events = uids.map((u) => liveStore.getEvent(u)).filter((e): e is CalEvent => !!e).slice(0, a.limit);
        return ok(events);
      }
      case "read_event": {
        return ok(requireStore().getEvent(requireString(raw, "uid")) ?? null);
      }
      case "create_event": {
        const args = parseCreateArgs(raw);
        const operationId = writeOps.start({
          kind: "calendar.create",
          input: args as unknown as Record<string, unknown>,
          expected: args as unknown as Record<string, unknown>,
        });
        try {
          const uid = await createEvent(args);
          writeOps.scriptReturned(operationId, { uid });
          return ok({ uid, operationId });
        } catch (err) {
          writeOps.failed(operationId, err);
          throw err;
        }
      }
      case "update_event": {
        const args = parseUpdateArgs(raw);
        const operationId = writeOps.start({
          kind: "calendar.update",
          input: args as unknown as Record<string, unknown>,
          expected: args as unknown as Record<string, unknown>,
        });
        try {
          await updateEvent(args);
          writeOps.scriptReturned(operationId, { uid: args.uid });
          return ok({ ok: true, operationId });
        } catch (err) {
          writeOps.failed(operationId, err);
          throw err;
        }
      }
      case "delete_event": {
        const uid = requireString(raw, "uid");
        const operationId = writeOps.start({
          kind: "calendar.delete",
          input: { uid },
          expected: { uid },
        });
        try {
          await deleteEvent(uid);
          writeOps.scriptReturned(operationId, { uid });
          return ok({ ok: true, operationId });
        } catch (err) {
          writeOps.failed(operationId, err);
          throw err;
        }
      }
      default: throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${req.params.name}`);
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    throw new McpError(ErrorCode.InternalError, e instanceof Error ? e.message : String(e));
  }
});

await server.connect(new StdioServerTransport());
