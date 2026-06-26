import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { indexDbPath as contactsIndexDbPath } from "../../contacts-mcp/src/paths.ts";
import { indexDbPath as calendarIndexDbPath } from "../../calendar-mcp/src/paths.ts";

export interface ContactContext {
  matches: { uid: string; displayName: string; organization: string | null; primaryEmail: string | null }[];
}

export function lookupContactContext(args: { fromName: string; fromAddr: string; limit?: number }): ContactContext {
  const path = contactsIndexDbPath();
  if (!existsSync(path)) return { matches: [] };
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const email = args.fromAddr.toLowerCase();
    const domain = email.includes("@") ? email.split("@").at(-1) ?? "" : "";
    const nameTokens = args.fromName.match(/[\p{L}\p{N}]+/gu) ?? [];
    const like = `%${email}%`;
    const domainLike = domain ? `%@${domain}` : "";
    const rows = db.prepare(
      `SELECT uid, display_name, organization, primary_email
       FROM contacts
       WHERE lower(coalesce(primary_email,'')) = ?
          OR lower(coalesce(primary_email,'')) LIKE ?
          OR lower(coalesce(display_name,'')) LIKE ?
          OR (? != '' AND lower(coalesce(primary_email,'')) LIKE ?)
       LIMIT ?`,
    ).all(
      email,
      like,
      `%${nameTokens[0]?.toLowerCase() ?? ""}%`,
      domain,
      domainLike,
      args.limit ?? 5,
    ) as { uid: string; display_name: string | null; organization: string | null; primary_email: string | null }[];
    return {
      matches: rows.map((r) => ({
        uid: r.uid,
        displayName: r.display_name ?? "",
        organization: r.organization,
        primaryEmail: r.primary_email,
      })),
    };
  } catch {
    return { matches: [] };
  } finally {
    db.close();
  }
}

export interface CalendarBlock {
  uid: string;
  summary: string;
  start: string;
  end: string;
  calendar: string | null;
}

export interface CalendarContext {
  requestedSlots: { start: string; end: string; available: boolean; conflicts: CalendarBlock[] }[];
  nearbyEvents: CalendarBlock[];
}

export function lookupCalendarContext(slots: { start: string; end: string }[], opts: { horizonDays?: number } = {}): CalendarContext {
  const path = calendarIndexDbPath();
  if (!existsSync(path)) return { requestedSlots: [], nearbyEvents: [] };
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const requestedSlots = slots
      .filter((s) => Number.isFinite(Date.parse(s.start)) && Number.isFinite(Date.parse(s.end)))
      .map((slot) => {
        const conflicts = db.prepare(
          `SELECT uid, summary, start, end, calendar
           FROM events
           WHERE COALESCE(status, 1) != 3
             AND start < ? AND end > ?
           ORDER BY start ASC
           LIMIT 10`,
        ).all(slot.end, slot.start) as CalendarBlock[];
        return { ...slot, available: conflicts.length === 0, conflicts };
      });
    const now = new Date();
    const horizon = new Date(now.getTime() + (opts.horizonDays ?? 14) * 86400_000);
    const nearbyEvents = db.prepare(
      `SELECT uid, summary, start, end, calendar
       FROM events
       WHERE COALESCE(status, 1) != 3 AND start >= ? AND start <= ?
       ORDER BY start ASC
       LIMIT 40`,
    ).all(now.toISOString(), horizon.toISOString()) as CalendarBlock[];
    return { requestedSlots, nearbyEvents };
  } catch {
    return { requestedSlots: [], nearbyEvents: [] };
  } finally {
    db.close();
  }
}

export async function lookupWikiContext(query: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const endpoint = process.env.ACTION_CENTER_LLM_WIKI_API ?? "http://127.0.0.1:19828/api/v1";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetchImpl(`${endpoint}/projects/current/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, topK: 5, includeContent: false }),
      signal: controller.signal,
    });
    if (!res.ok) return { available: false, error: `http ${res.status}` };
    const json = await res.json() as unknown;
    return { available: true, results: json };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
