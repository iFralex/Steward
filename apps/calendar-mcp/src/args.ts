import type { CreateArgs, UpdateArgs } from "./applescript.ts";

type Raw = Record<string, unknown>;

// Calendar tools exchange instants, not floating wall-clock values. Requiring
// an explicit offset prevents the same input from meaning different instants
// on Macs in different time zones (and across daylight-saving transitions).
const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

export function requireString(raw: Raw, field: string): string {
  const v = raw[field];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`"${field}" is required and must be a non-empty string`);
  return v;
}

function optString(raw: Raw, field: string): string | undefined {
  const v = raw[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${field}" must be a string`);
  return v;
}

/** An optional array of alert offsets in minutes before the event (non-negative). */
function optMinutesArray(raw: Raw, field: string): number[] | undefined {
  const v = raw[field];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) {
    throw new Error(`"${field}" must be an array of non-negative numbers (minutes before the event)`);
  }
  return v as number[];
}

function validIso(raw: Raw, field: string, required: boolean): string | undefined {
  const v = optString(raw, field);
  if (v === undefined) { if (required) throw new Error(`"${field}" is required (RFC 3339 date-time with an explicit timezone)`); return undefined; }
  if (!RFC3339_INSTANT.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error(`"${field}" must be an RFC 3339 date-time with an explicit timezone (Z or ±HH:MM)`);
  }
  // One canonical representation across search, create, update, persistence,
  // previews, and tool results. Calendar.app still displays it in local time.
  return new Date(v).toISOString();
}

export function parseSearchArgs(raw: Raw): { query?: string; start: string; end: string; account?: string; calendar?: string; limit: number; offset: number; fetchLimit: number } {
  const now = Date.now();
  const start = validIso(raw, "start", false) ?? new Date(now - 30 * 86400_000).toISOString();
  const end = validIso(raw, "end", false) ?? new Date(now + 90 * 86400_000).toISOString();
  const limitRaw = raw.limit;
  const limit = typeof limitRaw === "number" && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 20) : 10;
  const offsetRaw = raw.offset;
  const offset = typeof offsetRaw === "number" && Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
  const fetchLimit = Math.min(offset + limit + 1, 100);
  return { query: optString(raw, "query"), start, end, account: optString(raw, "account"), calendar: optString(raw, "calendar"), limit, offset, fetchLimit };
}

export function parseCreateArgs(raw: Raw): CreateArgs {
  const start = validIso(raw, "start", true)!;
  const end = validIso(raw, "end", true)!;
  if (Date.parse(end) <= Date.parse(start)) throw new Error('"end" must be after start');
  return {
    calendar: requireString(raw, "calendar"),
    summary: requireString(raw, "summary"),
    start, end,
    allDay: raw.allDay === true,
    location: optString(raw, "location"),
    description: optString(raw, "description"),
    url: optString(raw, "url"),
    recurrence: optString(raw, "recurrence"),
    alarms: optMinutesArray(raw, "alarms"),
  };
}

export function parseUpdateArgs(raw: Raw): UpdateArgs {
  return {
    uid: requireString(raw, "uid"),
    summary: optString(raw, "summary"),
    start: validIso(raw, "start", false),
    end: validIso(raw, "end", false),
    location: optString(raw, "location"),
    description: optString(raw, "description"),
    url: optString(raw, "url"),
    recurrence: optString(raw, "recurrence"),
    alarms: optMinutesArray(raw, "alarms"),
  };
}
