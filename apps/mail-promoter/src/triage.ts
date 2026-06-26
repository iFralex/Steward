import { extractJson } from "../../llm-gateway/src/extract-json.ts";
import type { DistilledNote } from "./note.ts";
import type { Chat } from "./llm.ts";
import { cleanBody } from "./clean-body.ts";

const CATEGORIES = ["commitment", "document", "personal-fact", "decision", "relationship"];
const ATTACHMENT_CATEGORIES = [
  "cv", "cover-letter", "career", "contract", "certificate", "financial", "legal", "portfolio", "project", "identity", "other",
];

// One LLM call does the whole job: decide whether the email holds durable
// personal knowledge AND, when it does, distil it. Splitting these into two
// round-trips only paid off when a cheap gate fronted an expensive distiller;
// with one capable cheap model handling both, the second call is pure overhead.
const SYSTEM =
  `You triage an email for the user's long-term PERSONAL memory IN ONE STEP. ` +
  `The body may be a single email or an entire THREAD (several messages in chronological order); ` +
  `in either case produce ONE note covering the whole conversation. ` +
  `Decide whether it holds DURABLE PERSONAL KNOWLEDGE worth keeping — the user's own ` +
  `requests/commitments, important documents, personal facts, decisions, relationships — ` +
  `and separately decide which attachments, if any, are durable source documents worth ingesting. ` +
  `vs noise (marketing, promotions, time-limited offers, notifications, one-off transactional, generic announcements). ` +
  `Reply with ONLY JSON: ` +
  `{"promoteMail": boolean, "categories": string[], "note": {"summary": string, "facts": string[], "commitments": string[], "people": string[], "orgs": string[], "reviewBy": "YYYY-MM-DD" | null} | null, ` +
  `"attachments": [{"id": string, "promote": boolean, "reason": string, "categories": string[]}]}. ` +
  `Rules: ` +
  `(1) Do NOT promote promotional or time-limited content (discounts, sales, event invites, deadlines) — noise even if still valid. ` +
  `(2) Do NOT promote service/transactional notifications and reminders (confirmations, onboarding/funnel steps, ` +
  `"resume/complete your application", identity-verification prompts, status updates) UNLESS they carry a DURABLE fact ` +
  `(an account/user code, IBAN, credentials, a real document/statement) OR they require an action or appointment still in the ` +
  `FUTURE relative to Today (e.g. a call/meeting scheduled after Today) — keep those, and record the WHEN. ` +
  `A reminder whose action is already past relative to Today is noise. ` +
  `(3) The header gives the email's Date and Today. Judge knowledge by whether it stays useful over time; ` +
  `record a request/commitment as a durable fact with WHO and WHEN — an old, already-resolved one is historical context, not a live task. ` +
  `(4) PERSONAL INVOLVEMENT: the header may list "You" (the user's own email addresses) and the To/Cc recipients. ` +
  `Promote only when the user is personally involved — they are the sender, a direct recipient, the message replies to the user's own question/request, ` +
  `or it is clearly about the user's own life, work, money, health, documents, or relationships. ` +
  `Treat mailing-list or forum threads where OTHER people discuss generic questions (the user is only a subscriber, not addressed) as noise — skip them. ` +
  `(5) categories ⊆ ${JSON.stringify(CATEGORIES)}. ` +
  `(6) Attachment decisions are independent from promoteMail: promote durable user-owned documents such as CVs, cover letters, ` +
  `portfolio/project documents, contracts, certificates, official/financial/legal documents, or other files likely useful in long-term memory. ` +
  `Do not promote logos, signatures, calendar invites, tracking pixels, generic brochures, duplicated noise, or transient attachments. ` +
  `For attachments[].categories use only ${JSON.stringify(ATTACHMENT_CATEGORIES)}. ` +
  `If promoteMail is false, set note to null. If promoteMail is true, fill note: summary 1-3 sentences; ` +
  `facts concrete durable facts; commitments requests/promises (who owes what); people/orgs named entities. ` +
  `reviewBy: if the note involves a future deadline, a scheduled event, or an action to revisit, set it to the date to revisit ` +
  `(the deadline/event date, or shortly before, as YYYY-MM-DD); use null when the knowledge is timeless or already resolved. ` +
  `Keep it faithful; do not invent.`;

function isoDay(epochSeconds?: number): string {
  if (!epochSeconds) return "unknown";
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface TriageResult {
  /** True when either the mail note or at least one attachment should be promoted. */
  promote: boolean;
  /** True only when the mail/thread should become a distilled note. */
  promoteMail: boolean;
  categories: string[];
  note: DistilledNote | null;
  attachments: AttachmentDecision[];
}

export interface AttachmentForTriage {
  id: string;
  filename: string;
  mime: string;
  size: number;
  messageId: string;
}

export interface AttachmentDecision {
  id: string;
  promote: boolean;
  reason: string;
  categories: string[];
}

/**
 * Classify + distil in a single call. Returns null (defer, retry next run) when
 * the model is unavailable/unparseable, or when it promotes without a usable
 * note — a promote we cannot turn into a note is not actionable.
 */
export async function triage(
  msg: { fromName: string; fromAddr: string; subject: string; bodyText: string; date?: number; to?: string[]; cc?: string[] },
  chat: Chat,
  opts: { userAddrs?: string[]; isThread?: boolean; attachments?: AttachmentForTriage[] } = {},
): Promise<TriageResult | null> {
  const recipients = [...(msg.to ?? []), ...(msg.cc ?? [])].filter(Boolean).join(", ");
  const youLine = opts.userAddrs?.length ? `You: ${opts.userAddrs.join(", ")}\n` : "";
  const toLine = recipients ? `To/Cc: ${recipients}\n` : "";
  // For a thread, bodyText is already a rendered, per-message-cleaned transcript
  // (cleaning it again would cut at quote markers and drop later messages); for a
  // single email, clean it here. Threads get more room.
  const body = opts.isThread ? msg.bodyText : cleanBody(msg.bodyText).slice(0, 8000);
  const threadHint = opts.isThread ? "[EMAIL THREAD — messages below in chronological order]\n" : "";
  const attachmentLine = opts.attachments?.length
    ? `\n\nAttachments available for independent promotion:\n${opts.attachments
      .map((a) => `- id=${a.id}; filename=${a.filename}; mime=${a.mime}; size=${a.size}; messageId=${a.messageId}`)
      .join("\n")}`
    : "";
  const user =
    `From: ${msg.fromName} <${msg.fromAddr}>\n${youLine}${toLine}Subject: ${msg.subject}\n` +
    `Date: ${isoDay(msg.date)}\nToday: ${isoDay(Math.floor(Date.now() / 1000))}\n\n` +
    `${threadHint}${body}${attachmentLine}`;
  try {
    const out = (await chat(SYSTEM, user)) as string;
    const p = extractJson(out) as { promote?: unknown; promoteMail?: unknown; categories?: unknown; note?: unknown; attachments?: unknown };
    const promoteMail = typeof p.promoteMail === "boolean" ? p.promoteMail : p.promote;
    if (typeof promoteMail !== "boolean") return null;
    const categories = Array.isArray(p.categories)
      ? p.categories.filter((c): c is string => typeof c === "string" && CATEGORIES.includes(c))
      : [];
    const attachmentIds = new Set((opts.attachments ?? []).map((a) => a.id));
    const attachments = parseAttachmentDecisions(p.attachments, attachmentIds);
    const promotesAttachment = attachments.some((a) => a.promote);
    if (!promoteMail) return { promote: promotesAttachment, promoteMail: false, categories, note: null, attachments };
    const n = p.note as Record<string, unknown> | null | undefined;
    if (!n || typeof n.summary !== "string" || !n.summary.trim()) return null; // malformed promote -> retry
    const reviewBy = typeof n.reviewBy === "string" && /^\d{4}-\d{2}-\d{2}$/.test(n.reviewBy) ? n.reviewBy : null;
    return {
      promote: true,
      promoteMail: true,
      categories,
      note: { summary: n.summary, facts: strs(n.facts), commitments: strs(n.commitments), people: strs(n.people), orgs: strs(n.orgs), reviewBy },
      attachments,
    };
  } catch {
    return null;
  }
}

function parseAttachmentDecisions(raw: unknown, allowedIds: Set<string>): AttachmentDecision[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AttachmentDecision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || (allowedIds.size > 0 && !allowedIds.has(r.id)) || seen.has(r.id)) continue;
    seen.add(r.id);
    const categories = strs(r.categories).filter((c) => ATTACHMENT_CATEGORIES.includes(c));
    out.push({
      id: r.id,
      promote: r.promote === true,
      reason: typeof r.reason === "string" ? r.reason.slice(0, 500) : "",
      categories,
    });
  }
  return out;
}
