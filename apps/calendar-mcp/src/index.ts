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
import { embedText } from "@steward/search";
import { createEvent, updateEvent, deleteEvent } from "./applescript.ts";
import {
  createEventKit, deleteEventKit, eventKitBridgeAvailable, eventKitCanRepresent, updateEventKit, searchEventKit, readEventKit,
} from "./eventkit-client.ts";
import { filterEventText, requireCompatibleScope, validateEventUpdate } from "./write-validation.ts";
import { parseSearchArgs, parseCreateArgs, parseDeleteArgs, parseUpdateArgs, requireString } from "./args.ts";
import { applePath, indexDbPath } from "./paths.ts";
import { WriteOpsStore } from "@steward/write-ops";
import { buildEventSearchPage } from "./event-page.ts";
import { eventForTool } from "./tool-event.ts";

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

const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const instantDescription = `RFC 3339 date-time with explicit timezone (Z or ±HH:MM). User-facing wall-clock times are in this Mac's ${localTimeZone} timezone; inputs are normalized internally and event outputs include the date-specific local offset.`;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "list_calendars", description: "List calendars with stable id, title and account. Use calendarId for writes, especially when titles repeat.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "search_events", description: `Search a compact page of events (hybrid keyword+semantic). All filters are optional and ANDed. Defaults to 10 events; follow page.nextOffset only when more are materially needed. Use read_event for a full description. Returned start/end use this Mac's ${localTimeZone} wall-clock time with an explicit offset; do not reinterpret them as UTC.`, inputSchema: { type: "object", properties: {
      query: { type: "string" }, start: { type: "string", description: `Inclusive range start. ${instantDescription}` }, end: { type: "string", description: `Exclusive range end. ${instantDescription}` },
      account: { type: "string" }, calendar: { type: "string" }, limit: { type: "number", description: "Page size; defaults to 10 and is capped at 20." },
      offset: { type: "number", description: "Rank offset from page.nextOffset." } }, additionalProperties: false } },
    { name: "read_event", description: `Read one event by uid. Returned start/end use this Mac's ${localTimeZone} wall-clock time with an explicit offset; do not reinterpret them as UTC.`, inputSchema: { type: "object", properties: { uid: { type: "string" }, occurrenceStart: { type: "string", description: "Exact recurring occurrence start from search_events." } }, required: ["uid"], additionalProperties: false } },
    { name: "create_event", description: "Create a calendar event. Prefer the stable calendarId from list_calendars; a duplicate calendar title without calendarId is rejected.", inputSchema: { type: "object", properties: {
      calendarId: { type: "string" }, calendar: { type: "string", description: "Legacy title selector; accepted only when unique." }, summary: { type: "string" }, start: { type: "string", description: instantDescription }, end: { type: "string", description: instantDescription },
      allDay: { type: "boolean", description: "Marks an all-day event. Pass start/end at local midnight with an explicit offset so the civil dates remain unambiguous." }, location: { type: "string" }, description: { type: "string" }, url: { type: "string" }, recurrence: { type: "string", description: "RFC 5545 RRULE. EventKit natively supports DAILY/WEEKLY/MONTHLY/YEARLY plus INTERVAL, COUNT/UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYWEEKNO, BYYEARDAY and BYSETPOS." },
      alarms: { type: "array", items: { type: "number" }, description: "alerts in minutes before the event, e.g. [15, 1440] = 15 min + 1 day before" } },
      required: ["summary", "start", "end"], additionalProperties: false } },
    { name: "update_event", description: "Update fields of an event by uid.", inputSchema: { type: "object", properties: {
      uid: { type: "string" }, summary: { type: "string" }, start: { type: "string", description: instantDescription }, end: { type: "string", description: instantDescription },
      location: { type: "string" }, description: { type: "string" }, url: { type: "string" }, recurrence: { type: "string", description: "RFC 5545 RRULE; fields outside EventKit's native subset use the compatibility fallback." },
      occurrenceStart: { type: "string", description: "Exact occurrence start returned by search_events; required for recurring changes." },
      scope: { type: "string", enum: ["thisEvent", "futureEvents"], description: "For a recurring event, update only this occurrence or this and all future occurrences." },
      alarms: { type: "array", items: { type: "number" }, description: "replaces the event's alerts; minutes before start; [] clears all" } },
      required: ["uid"], additionalProperties: false } },
    { name: "delete_event", description: "Delete an event by uid.", inputSchema: { type: "object", properties: {
      uid: { type: "string" }, occurrenceStart: { type: "string", description: "Exact occurrence start for recurring deletion." }, scope: { type: "string", enum: ["thisEvent", "futureEvents"], description: "For a recurring event, delete only this occurrence or this and all future occurrences." },
    }, required: ["uid"], additionalProperties: false } },
  ],
}));

function ok(data: unknown) { return { content: [{ type: "text", text: JSON.stringify(data) }] }; }

function calendarPermissionError(err?: unknown): string {
  const detail = err instanceof Error ? err.message : err ? String(err) : "";
  return [
    "Apple Calendar store is not readable.",
    "Grant Full Disk Access to Steward.app in System Settings -> Privacy & Security -> Full Disk Access, then restart Steward.",
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
        const dateExplicit = typeof raw.start === "string" || typeof raw.end === "string";
        if (eventKitBridgeAvailable() && (dateExplicit || !a.query)) {
          const events = filterEventText(await searchEventKit(a), a.query);
          return ok(buildEventSearchPage(events.slice(a.offset, a.offset + a.limit + 1).map(eventForTool), a.limit, a.offset));
        }
        if (a.query && index) {
          // Keyword/semantic search applies the date window only when the caller
          // gave one explicitly — defaulting it would silently hurt recall.
          const dateExplicit = typeof raw.start === "string" || typeof raw.end === "string";
          uids = await hybridSearch({ index, embedQuery }, a.query, a.fetchLimit, {
            account: a.account,
            calendar: a.calendar,
            ...(dateExplicit ? { startISO: a.start, endISO: a.end } : {}),
          });
        } else {
          if (liveStore.allForIndex().some(e => e.hasRecurrence && (!a.account || e.account === a.account) && (!a.calendar || e.calendar === a.calendar))) {
            throw new Error('Complete recurring availability requires the EventKit bridge. Start Steward launcher; no incomplete availability result was returned.');
          }
          uids = filterEventText(liveStore.eventsInRange({ startISO: a.start, endISO: a.end, account: a.account, calendar: a.calendar }), a.query).map(e => e.uid);
        }
        // Both paths already applied the account/calendar/date filters; just resolve live detail.
        const events = uids.slice(a.offset, a.offset + a.limit + 1)
          .map((u) => liveStore.getEvent(u)).filter((e): e is CalEvent => !!e);
        return ok(buildEventSearchPage(events.map(eventForTool), a.limit, a.offset));
      }
      case "read_event": {
        const requestedUid = requireString(raw, "uid");
        const uid = index?.resolveUid(requestedUid) ?? requestedUid;
        const event = eventKitBridgeAvailable() ? await readEventKit(uid, parseDeleteArgs(raw).occurrenceStart) : requireStore().getEvent(uid);
        return ok(event ? eventForTool(event) : null);
      }
      case "create_event": {
        const args = parseCreateArgs(raw);
        if (!args.calendarId) {
          const matches = requireStore().listCalendars().filter((calendar) => calendar.title === args.calendar);
          if (matches.length !== 1) {
            throw new Error(matches.length
              ? `Calendar title "${args.calendar}" is ambiguous; pass calendarId from list_calendars`
              : `Calendar "${args.calendar}" was not found`);
          }
          args.calendarId = matches[0].id;
        }
        const operationId = writeOps.start({
          kind: "calendar.create",
          input: args as unknown as Record<string, unknown>,
          expected: args as unknown as Record<string, unknown>,
        });
        try {
          const useEventKit = eventKitBridgeAvailable() && eventKitCanRepresent(args.recurrence);
          let uid: string;
          if (useEventKit) {
            uid = await createEventKit(args);
          } else {
            const calendars = requireStore().listCalendars();
            const selected = calendars.find((calendar) => calendar.id === args.calendarId);
            if (!selected) throw new Error(`Calendar id "${args.calendarId}" was not found`);
            if (calendars.filter((calendar) => calendar.title === selected.title).length !== 1) {
              throw new Error(`Calendar "${selected.title}" is not unique, and this recurrence cannot be represented by EventKit safely`);
            }
            // Calendar.app exposes calendarIdentifier in its scripting
            // dictionary but returns -10000 for it on current macOS. The
            // compatibility path can therefore select only a unique title.
            uid = await createEvent({ ...args, calendar: selected.title, calendarId: undefined });
          }
          writeOps.scriptReturned(operationId, { uid });
          return ok({ uid, operationId });
        } catch (err) {
          writeOps.failed(operationId, err);
          throw err;
        }
      }
      case "update_event": {
        const args = parseUpdateArgs(raw);
        args.uid = index?.resolveUid(args.uid) ?? args.uid;
        const useEventKit = eventKitBridgeAvailable() && eventKitCanRepresent(args.recurrence);
        const current = eventKitBridgeAvailable() ? await readEventKit(args.uid, args.occurrenceStart) ?? undefined : requireStore().getEvent(args.uid);
        validateEventUpdate(args, current);
        requireCompatibleScope(args, useEventKit, current?.hasRecurrence ?? false);
        if (current?.hasRecurrence && !args.occurrenceStart) throw new Error('Recurring updates require occurrenceStart from search_events');
        const operationId = writeOps.start({
          kind: "calendar.update",
          input: args as unknown as Record<string, unknown>,
          expected: args as unknown as Record<string, unknown>,
        });
        try {
          if (useEventKit) await updateEventKit(args);
          else await updateEvent(args);
          writeOps.scriptReturned(operationId, { uid: args.uid });
          return ok({ ok: true, operationId });
        } catch (err) {
          writeOps.failed(operationId, err);
          throw err;
        }
      }
      case "delete_event": {
        const parsed = parseDeleteArgs(raw);
        const requestedUid = parsed.uid;
        const uid = index?.resolveUid(requestedUid) ?? requestedUid;
        const scope = parsed.scope;
        const target = eventKitBridgeAvailable() ? await readEventKit(uid, parsed.occurrenceStart) : requireStore().getEvent(uid);
        if (!target) throw new Error('Calendar event not found; nothing was deleted');
        requireCompatibleScope(parsed, eventKitBridgeAvailable(), target.hasRecurrence);
        if (target.hasRecurrence && !parsed.occurrenceStart) throw new Error('Recurring deletion requires occurrenceStart from search_events');
        const operationId = writeOps.start({
          kind: "calendar.delete",
          input: { uid, scope, occurrenceStart: parsed.occurrenceStart },
          expected: { uid, scope, occurrenceStart: parsed.occurrenceStart, targetExisted: true },
        });
        try {
          if (eventKitBridgeAvailable()) await deleteEventKit(uid, scope, parsed.occurrenceStart);
          else if (scope === "thisEvent") await deleteEvent(uid);
          else throw new Error('Deleting "this and future" occurrences requires the Steward EventKit bridge');
          // Always hand deletion to reconciliation. EventKit commits locally,
          // but the SQLite mirror can lag behind the framework response.
          writeOps.scriptReturned(operationId, { uid });
          return ok({ ok: true, status: "pending_confirmation", uid, operationId });
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
