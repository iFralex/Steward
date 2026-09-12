import type { Chat } from "./llm.ts";
import { jsonFromLlm } from "./llm.ts";
import type { ActionItem } from "./types.ts";
import type { RelatedActionCandidate } from "./types.ts";

const MAX_CANDIDATES = 5;
const MAX_CONTINUATION_CANDIDATES = 1;
const MAX_RELATED_SUMMARY_CHARS = 500;

function domainOf(addr: string): string {
  return addr.split("@")[1]?.trim().toLowerCase() ?? "";
}

/** `mail.from` in a stored contextSnapshot is either a bare address or "Name <addr>". */
function extractEmail(value: string): string {
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1] : value).trim().toLowerCase();
}

/**
 * Open mail actions whose correspondent shares a domain with a newly-seen
 * message, even though the message landed on a different mirror thread_id
 * (e.g. a corporate ticketing system that doesn't preserve RFC threading
 * headers). Excludes the user's own domain and any action already tied to
 * the message's own thread (that case is handled by the normal upsert path).
 * Capped to the most recently updated `MAX_CANDIDATES` matches.
 */
export function findResolvableOpenActions(
  openActions: ActionItem[],
  newMessage: { fromAddr: string; threadId: number | null },
  userAddrs: string[],
): ActionItem[] {
  const newDomain = domainOf(newMessage.fromAddr);
  if (!newDomain) return [];
  const userDomains = new Set(userAddrs.map(domainOf));
  if (userDomains.has(newDomain)) return [];

  const matches = openActions.filter((action) => {
    if (action.sourceKind !== "mail") return false;
    if (typeof newMessage.threadId === "number" && action.payload.threadId === newMessage.threadId) return false;
    const mail = (action.payload.contextSnapshot as { mail?: { to?: unknown; from?: unknown } } | undefined)?.mail;
    if (!mail) return false;
    const domains = new Set<string>();
    if (typeof mail.from === "string") domains.add(domainOf(extractEmail(mail.from)));
    if (Array.isArray(mail.to)) {
      for (const addr of mail.to) if (typeof addr === "string") domains.add(domainOf(addr));
    }
    return domains.has(newDomain);
  });

  return matches
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CANDIDATES);
}

/**
 * Cheap local shortlist for the planner's same-issue merge decision. Domain is
 * only the initial safety boundary; identifiers and specific shared terms rank
 * candidates, so recurring notification senders don't flood every prompt.
 */
export function selectContinuationCandidates(
  openActions: ActionItem[],
  message: { fromAddr: string; threadId: number | null; subject: string; bodyText: string },
  userAddrs: string[],
): RelatedActionCandidate[] {
  const sameDomain = findSameDomainActions(openActions, message, userAddrs);
  if (sameDomain.length === 0) return [];
  const query = `${message.subject}\n${message.bodyText.slice(0, 3000)}`;
  const ignoredDomainTokens = domainTokenHints(domainOf(message.fromAddr));
  const queryTokens = meaningfulTokens(query, ignoredDomainTokens);
  const subjectTokens = meaningfulTokens(message.subject, ignoredDomainTokens);
  const queryAnchors = strongAnchors(query);
  const ranked = sameDomain.map((action) => {
    const candidateText = `${action.title}\n${action.summary}`;
    const candidateTokens = meaningfulTokens(candidateText, ignoredDomainTokens);
    const titleTokens = meaningfulTokens(action.title, ignoredDomainTokens);
    const sharedTokens = [...queryTokens].filter((token) => candidateTokens.has(token));
    const sharedTitleTokens = [...subjectTokens].filter((token) => titleTokens.has(token));
    const candidateAnchors = strongAnchors(candidateText);
    const sharedAnchors = [...queryAnchors].filter((anchor) => candidateAnchors.has(anchor));
    // Stable identifiers are stronger than prose similarity. If either side names
    // one, require an exact shared identifier rather than guessing from a brand or
    // a recurring notification template.
    const conflictingAnchors = (queryAnchors.size > 0 || candidateAnchors.size > 0) && sharedAnchors.length === 0;
    const score = sharedAnchors.length * 100 + sharedTokens.reduce((sum, token) => sum + Math.min(token.length, 12), 0);
    return { action, score, sharedAnchors: sharedAnchors.length, sharedTokens: sharedTokens.length, sharedTitleTokens: sharedTitleTokens.length, conflictingAnchors };
  }).sort((a, b) => b.score - a.score || b.action.updatedAt - a.action.updatedAt);

  const plausible = ranked.filter((item) => !item.conflictingAnchors && (
    item.sharedAnchors > 0 || (item.sharedTokens >= 4 && item.sharedTitleTokens > 0)
  ));
  return plausible.slice(0, MAX_CONTINUATION_CANDIDATES).map(({ action }) => ({
    id: action.id,
    title: action.title.slice(0, 180),
    summary: action.summary.slice(0, MAX_RELATED_SUMMARY_CHARS),
    updatedAt: action.updatedAt,
  }));
}

function findSameDomainActions(
  openActions: ActionItem[],
  newMessage: { fromAddr: string; threadId: number | null },
  userAddrs: string[],
): ActionItem[] {
  const newDomain = domainOf(newMessage.fromAddr);
  if (!newDomain) return [];
  const userDomains = new Set(userAddrs.map(domainOf));
  if (userDomains.has(newDomain)) return [];
  return openActions.filter((action) => {
    if (action.sourceKind !== "mail") return false;
    if (typeof newMessage.threadId === "number" && action.payload.threadId === newMessage.threadId) return false;
    const mail = (action.payload.contextSnapshot as { mail?: { to?: unknown; from?: unknown } } | undefined)?.mail;
    if (!mail) return false;
    const domains = new Set<string>();
    if (typeof mail.from === "string") domains.add(domainOf(extractEmail(mail.from)));
    if (Array.isArray(mail.to)) for (const addr of mail.to) if (typeof addr === "string") domains.add(domainOf(addr));
    return domains.has(newDomain);
  });
}

const STOPWORDS = new Set([
  "about", "after", "alla", "alle", "anche", "automatic", "automatico", "avviso", "dalla", "delle", "della",
  "email", "from", "have", "into", "message", "messaggio", "nella", "nelle", "notifica", "notification", "oggi",
  "only", "prima", "richiesta", "service", "sono", "stato", "sulla", "this", "with", "your",
]);

function domainTokenHints(domain: string): Set<string> {
  const parts = domain.split(".").filter((part) => part.length >= 4 && !["com", "org", "net", "info"].includes(part));
  return new Set(parts);
}

function meaningfulTokens(text: string, domainHints: Set<string> = new Set()): Set<string> {
  return new Set(
    text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9*]+/)
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token) && !/^\d{1,3}$/.test(token))
      .filter((token) => ![...domainHints].some((hint) => hint.includes(token) || token.includes(hint))),
  );
}

function strongAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/\*{2,}\s*(\d{4})\b/g)) anchors.add(`last4:${match[1]}`);
  for (const match of lower.matchAll(/\b(?:invitationid|ordine|order|ticket|incident|pratica|conto|account)\s*[:#-]?\s*([a-z0-9-]{5,})\b/g)) {
    anchors.add(`id:${match[1]}`);
  }
  for (const match of lower.matchAll(/\b([a-z0-9_.-]{2,}\/[-a-z0-9_.]{2,})\b/g)) {
    if (!match[1].includes("http")) anchors.add(`path:${match[1]}`);
  }
  return anchors;
}

export interface ResolutionCheck {
  resolves: boolean;
  updatedSummary?: string;
}

const RESOLUTION_SYSTEM = `You check whether a new email resolves or updates a previously-open task in Alessio's action center.
Return ONLY JSON: {"resolves": boolean, "updatedSummary": string|null}
Rules:
- "resolves" is true only if the new email actually answers, completes, or meaningfully updates the open task described below (e.g. gives a timeline, confirms something was received, provides the missing information).
- If the new email is unrelated, generic, or does not add anything relevant to the open task, "resolves" must be false and "updatedSummary" must be null.
- When "resolves" is true, "updatedSummary" must be a short summary (1-3 sentences) that incorporates the new information from this email into the original task's context — not just a restatement of the email.`;

/** Ask the LLM whether `msg` resolves/updates `action` — used for messages the
 * planner already decided need no action of their own, to catch a reply that
 * landed on a different thread than the one an open action is tracking. */
export async function checkIfMessageResolvesAction(
  action: Pick<ActionItem, "title" | "summary">,
  msg: { subject: string; fromName: string; fromAddr: string; bodyText: string },
  chat: Chat,
): Promise<ResolutionCheck> {
  const prompt = [
    `Open task: ${action.title}`,
    `Current summary: ${action.summary}`,
    "",
    "New email:",
    `From: ${msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr}`,
    `Subject: ${msg.subject}`,
    msg.bodyText.slice(0, 2000),
  ].join("\n");
  const raw = await chat(RESOLUTION_SYSTEM, prompt);
  const parsed = jsonFromLlm<{ resolves?: unknown; updatedSummary?: unknown }>(raw);
  if (!parsed || typeof parsed.resolves !== "boolean" || !parsed.resolves) return { resolves: false };
  return typeof parsed.updatedSummary === "string" && parsed.updatedSummary.trim()
    ? { resolves: true, updatedSummary: parsed.updatedSummary.trim() }
    : { resolves: false };
}
