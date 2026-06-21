import type { CreateArgs, UpdateArgs } from "./applescript.ts";

type Raw = Record<string, unknown>;

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

function validIso(raw: Raw, field: string, required: boolean): string | undefined {
  const v = optString(raw, field);
  if (v === undefined) { if (required) throw new Error(`"${field}" is required (ISO date)`); return undefined; }
  if (Number.isNaN(Date.parse(v))) throw new Error(`"${field}" must be an ISO date`);
  return v;
}

export function parseSearchArgs(raw: Raw): { query?: string; start: string; end: string; account?: string; calendar?: string; limit: number } {
  const now = Date.now();
  const start = validIso(raw, "start", false) ?? new Date(now - 30 * 86400_000).toISOString();
  const end = validIso(raw, "end", false) ?? new Date(now + 90 * 86400_000).toISOString();
  const limitRaw = raw.limit;
  const limit = typeof limitRaw === "number" && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
  return { query: optString(raw, "query"), start, end, account: optString(raw, "account"), calendar: optString(raw, "calendar"), limit };
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
  };
}
