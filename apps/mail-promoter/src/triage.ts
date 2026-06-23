import { extractJson } from "../../llm-gateway/src/extract-json.ts";
import type { DistilledNote } from "./note.ts";
import type { Chat } from "./llm.ts";
import { cleanBody } from "./clean-body.ts";

const CATEGORIES = ["commitment", "document", "personal-fact", "decision", "relationship"];

// One LLM call does the whole job: decide whether the email holds durable
// personal knowledge AND, when it does, distil it. Splitting these into two
// round-trips only paid off when a cheap gate fronted an expensive distiller;
// with one capable cheap model handling both, the second call is pure overhead.
const SYSTEM =
  `You triage an email for the user's long-term PERSONAL memory IN ONE STEP. ` +
  `Decide whether it holds DURABLE PERSONAL KNOWLEDGE worth keeping — the user's own ` +
  `requests/commitments, important documents, personal facts, decisions, relationships — ` +
  `vs noise (marketing, promotions, time-limited offers, notifications, one-off transactional, generic announcements). ` +
  `Reply with ONLY JSON: ` +
  `{"promote": boolean, "categories": string[], "note": {"summary": string, "facts": string[], "commitments": string[], "people": string[], "orgs": string[]} | null}. ` +
  `Rules: ` +
  `(1) Do NOT promote promotional or time-limited content (discounts, sales, event invites, deadlines) — noise even if still valid. ` +
  `(2) The header gives the email's Date and Today. Judge knowledge by whether it stays useful over time; ` +
  `record a request/commitment as a durable fact with WHO and WHEN — an old one is historical context, not a live task. ` +
  `(3) PERSONAL INVOLVEMENT: the header may list "You" (the user's own email addresses) and the To/Cc recipients. ` +
  `Promote only when the user is personally involved — they are the sender, a direct recipient, the message replies to the user's own question/request, ` +
  `or it is clearly about the user's own life, work, money, health, documents, or relationships. ` +
  `Treat mailing-list or forum threads where OTHER people discuss generic questions (the user is only a subscriber, not addressed) as noise — skip them. ` +
  `(4) categories ⊆ ${JSON.stringify(CATEGORIES)}. ` +
  `If promote is false, set note to null. If promote is true, fill note: summary 1-3 sentences; ` +
  `facts concrete durable facts; commitments requests/promises (who owes what); people/orgs named entities. ` +
  `Keep it faithful; do not invent.`;

function isoDay(epochSeconds?: number): string {
  if (!epochSeconds) return "unknown";
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface TriageResult {
  promote: boolean;
  categories: string[];
  note: DistilledNote | null;
}

/**
 * Classify + distil in a single call. Returns null (defer, retry next run) when
 * the model is unavailable/unparseable, or when it promotes without a usable
 * note — a promote we cannot turn into a note is not actionable.
 */
export async function triage(
  msg: { fromName: string; fromAddr: string; subject: string; bodyText: string; date?: number; to?: string[]; cc?: string[] },
  chat: Chat,
  opts: { userAddrs?: string[] } = {},
): Promise<TriageResult | null> {
  const recipients = [...(msg.to ?? []), ...(msg.cc ?? [])].filter(Boolean).join(", ");
  const youLine = opts.userAddrs?.length ? `You: ${opts.userAddrs.join(", ")}\n` : "";
  const toLine = recipients ? `To/Cc: ${recipients}\n` : "";
  const user =
    `From: ${msg.fromName} <${msg.fromAddr}>\n${youLine}${toLine}Subject: ${msg.subject}\n` +
    `Date: ${isoDay(msg.date)}\nToday: ${isoDay(Math.floor(Date.now() / 1000))}\n\n` +
    `${cleanBody(msg.bodyText).slice(0, 8000)}`;
  try {
    const out = (await chat(SYSTEM, user)) as string;
    const p = extractJson(out) as { promote?: unknown; categories?: unknown; note?: unknown };
    if (typeof p.promote !== "boolean") return null;
    const categories = Array.isArray(p.categories)
      ? p.categories.filter((c): c is string => typeof c === "string" && CATEGORIES.includes(c))
      : [];
    if (!p.promote) return { promote: false, categories, note: null };
    const n = p.note as Record<string, unknown> | null | undefined;
    if (!n || typeof n.summary !== "string" || !n.summary.trim()) return null; // malformed promote -> retry
    return {
      promote: true,
      categories,
      note: { summary: n.summary, facts: strs(n.facts), commitments: strs(n.commitments), people: strs(n.people), orgs: strs(n.orgs) },
    };
  } catch {
    return null;
  }
}
