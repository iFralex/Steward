import type { CalEvent } from "./types.ts";

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * Render an instant as RFC 3339 in the Mac's local timezone. Apple Calendar's
 * store uses UTC instants internally, but tool callers reason about the same
 * wall-clock values the user sees in Calendar.app. The date-specific offset
 * also handles daylight-saving transitions without asking the model to infer
 * whether Rome is currently +01:00 or +02:00.
 */
export function toLocalRfc3339(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const eastOfUtcMinutes = -date.getTimezoneOffset();
  const sign = eastOfUtcMinutes >= 0 ? "+" : "-";
  const offset = Math.abs(eastOfUtcMinutes);
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`,
  ].join("");
}

/** Convert the UTC-backed internal event into the public MCP representation. */
export function eventForTool(event: CalEvent): CalEvent {
  return { ...event, start: toLocalRfc3339(event.start), end: toLocalRfc3339(event.end) };
}
