import type { Chat } from "./llm.ts";
import { jsonFromLlm } from "./llm.ts";
import type { ActionItem } from "./types.ts";

const MAX_CANDIDATES = 5;

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
