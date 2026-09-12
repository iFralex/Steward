import type { Chat } from "./llm.ts";
import { jsonFromLlm } from "./llm.ts";

export interface ReadToolCall {
  tool: string;
  input: Record<string, unknown>;
  reason: string;
}

export interface ReadToolObservation extends ReadToolCall {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type ReadToolExecutor = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

export const READ_TOOL_SPECS = [
  "mcp__mail__get_thread with {threadId? number, messageId? string, id? string, limit? number, offset? number}",
  "mcp__mail__read_message with {messageId? string, id? string, bodyOffset? number, bodyLimit? number}",
  "mcp__mail__search_messages with {query? string, subject? string, sender? string, recipient? string, cc? string, senderDomain? string, mailbox? string, anyMailbox? boolean, dateFrom? ISO string, dateTo? ISO string, fromName? string, fromAddr? string, toName? string, subjectContains? string, bodyContains? string, sort? 'date'|'size', sortDir? 'asc'|'desc', limit? number (max 6 here), offset? number, perMessage? boolean}",
  "mcp__calendar__list_calendars with {}",
  "mcp__calendar__search_events with {query? string, start? ISO string, end? ISO string, calendar? string, limit? number}",
  "mcp__calendar__read_event with {uid: string}",
  "mcp__contacts__search_contacts with {query: string, limit? number}",
  "mcp__contacts__read_contact with {uid: string}",
  "mcp__contacts__resolve_recipient with {query: string}",
  "mcp__llm-wiki__llm_wiki_search with {query: string, topK? number, includeContent? boolean}",
  "mcp__llm-wiki__llm_wiki_read_file with {path: string}",
] as const;

const ALLOWED_READ_TOOLS = new Set(READ_TOOL_SPECS.map((s) => s.split(" ")[0]));
const ACTION_MAIL_SEARCH_PAGE_SIZE = 6;

const TOOL_CONTEXT_SYSTEM = `You decide which read-only tools should be called before creating an Action Center item.
Return ONLY JSON:
{"toolCalls":[{"tool": string, "input": object, "reason": string}]}.
Available read-only tools:
${READ_TOOL_SPECS.map((s) => `- ${s}`).join("\n")}
Rules:
- Call tools only when they can materially validate or enrich the proposed action.
- Prefer precise calls: exact threadId/messageId, concrete calendar ranges, concrete contact names/domains.
- Mail searches are paginated and capped at six results in this context. Request another offset only when the first page shows that more results are materially necessary.
- Mail threads return the latest messages first as a chronological page. Follow page.earlierOffset only when older context is materially necessary; follow page.laterOffset when returning from an earlier page.
- Mail message bodies are exact, paginated character ranges. Follow bodyPage.nextOffset only when the current page indicates that omitted content is materially necessary.
- For scheduling, availability, absences, deadlines, events, or reminders, use calendar tools when useful.
- For sender identity or recipient ambiguity, use contacts tools when useful.
- For project/document/personal-memory context, use LLM Wiki tools when useful.
- For thread ambiguity, use mail thread/message tools when useful.
- For administrative replies where the answer may depend on facts the user already communicated elsewhere, search recent related mail across threads using the same sender/domain, recipients, and key terms from the task.
- If a current thread says "also", "forgot", "as mentioned", "you must specify", "nothing to report", attendance/absence/presence, expenses, documents, or deadlines, look for related recent sent and received messages before drafting final actions.
- If a wiki search is useful but unavailable or fails, continue with other read tools and preserve the uncertainty in observations.
- If previous observations reveal new facts that need validation, request additional read tools.
- Do not repeat calls already present in previous observations.
- Do not call write tools. Do not include unavailable tools. Respect the remaining call budget.`;

export async function collectReadToolContext(args: {
  chat: Chat;
  execute?: ReadToolExecutor;
  message: Record<string, unknown>;
  analyzed: Record<string, unknown>;
  maxCalls?: number;
}): Promise<{ requested: ReadToolCall[]; observations: ReadToolObservation[] }> {
  if (!args.execute) return { requested: [], observations: [] };
  const requested: ReadToolCall[] = [];
  const observations: ReadToolObservation[] = [];
  const maxCalls = args.maxCalls ?? 6;
  const seen = new Set<string>();

  const seeded = seedToolCalls(args.message, args.analyzed, maxCalls);
  if (seeded.length) {
    requested.push(...seeded);
    for (const call of seeded) {
      seen.add(callKey(call));
      try {
        const result = await args.execute(call.tool, call.input);
        observations.push({ ...call, ok: true, result: compactResult(result) });
      } catch (err) {
        observations.push({ ...call, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  for (let round = 0; round < 3 && requested.length < maxCalls; round++) {
    const raw = await args.chat(TOOL_CONTEXT_SYSTEM, JSON.stringify({
      message: args.message,
      analyzed: args.analyzed,
      previousObservations: observations,
      remainingCalls: maxCalls - requested.length,
    }, null, 2));
    const parsed = jsonFromLlm<Record<string, unknown>>(raw);
    const nextCalls = normalizeToolCalls(parsed?.toolCalls, maxCalls - requested.length)
      .filter((call) => {
        const key = callKey(call);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (!nextCalls.length) break;
    requested.push(...nextCalls);
    for (const call of nextCalls) {
      try {
        const result = await args.execute(call.tool, call.input);
        observations.push({ ...call, ok: true, result: compactResult(result) });
      } catch (err) {
        observations.push({ ...call, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { requested, observations };
}

export function isAllowedReadTool(tool: string): boolean {
  return ALLOWED_READ_TOOLS.has(tool);
}

function normalizeToolCalls(value: unknown, maxCalls: number): ReadToolCall[] {
  if (!Array.isArray(value)) return [];
  const out: ReadToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.tool !== "string" || !ALLOWED_READ_TOOLS.has(obj.tool)) continue;
    const rawInput = obj.input && typeof obj.input === "object" && !Array.isArray(obj.input) ? obj.input as Record<string, unknown> : {};
    out.push({
      tool: obj.tool,
      input: sanitizeReadToolInput(obj.tool, rawInput),
      reason: typeof obj.reason === "string" ? obj.reason : "",
    });
    if (out.length >= maxCalls) break;
  }
  return out;
}

function seedToolCalls(message: Record<string, unknown>, analyzed: Record<string, unknown>, maxCalls: number): ReadToolCall[] {
  if (maxCalls <= 0 || !looksLikeAdministrativeCrossThreadCase(message, analyzed)) return [];
  const calls: ReadToolCall[] = [];
  const threadId = typeof message.threadId === "number" && Number.isFinite(message.threadId) ? message.threadId : null;
  if (threadId != null) {
    calls.push({
      tool: "mcp__mail__get_thread",
      input: { threadId },
      reason: "Read the latest page of the current thread before drafting an administrative reply; fetch earlier history only if the page indicates it is materially necessary.",
    });
  }
  const sender = extractEmail(typeof message.from === "string" ? message.from : "");
  if (sender) {
    const messageDate = typeof message.date === "string" && Number.isFinite(Date.parse(message.date)) ? new Date(message.date) : new Date();
    const now = new Date();
    const dateFrom = new Date(messageDate.getTime() - 21 * 86400_000).toISOString();
    const dateTo = new Date(Math.max(now.getTime(), messageDate.getTime()) + 2 * 3600_000).toISOString();
    calls.push({
      tool: "mcp__mail__search_messages",
      input: {
        recipient: sender,
        anyMailbox: true,
        dateFrom,
        dateTo,
        sort: "date",
        sortDir: "desc",
        limit: ACTION_MAIL_SEARCH_PAGE_SIZE,
        perMessage: true,
      },
      reason: "Check recent mail involving the same person for related facts already communicated in another thread. Do not restrict to a Sent mailbox because localized/account-specific sent folders may not be role-classified.",
    });
  }
  return calls.slice(0, maxCalls);
}

function looksLikeAdministrativeCrossThreadCase(message: Record<string, unknown>, analyzed: Record<string, unknown>): boolean {
  const kind = typeof analyzed.kind === "string" ? analyzed.kind : "";
  const haystack = [
    kind,
    analyzed.summary,
    analyzed.reasoning,
    message.subject,
    message.bodyPreview,
  ].filter((v): v is string => typeof v === "string").join("\n").toLowerCase();
  if (!/(admin-task|reply-needed|follow-up)/.test(kind)) return false;
  return /\b(presenz|assen|ferie|rol|permess|scaric|ponte|malatt|timesheet|ore\s+off|giorni?|attendance|absence|leave|pto|holiday|vacation|expense|rimborso|document[oi]?|scadenz|deadline|segnalar|specifica|dimentic|integra|also|forgot|as mentioned)\b/i.test(haystack);
}

function extractEmail(value: string): string | null {
  const angle = value.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (angle?.[1]) return angle[1].toLowerCase();
  const plain = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return plain?.[0].toLowerCase() ?? null;
}

function sanitizeReadToolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool !== "mcp__mail__search_messages") return input;
  const normalized = { ...input };
  if (typeof normalized.since === "string" && typeof normalized.dateFrom !== "string") normalized.dateFrom = normalized.since;
  if (typeof normalized.until === "string" && typeof normalized.dateTo !== "string") normalized.dateTo = normalized.until;
  if (typeof normalized.from === "string" && typeof normalized.sender !== "string") normalized.sender = normalized.from;
  if (typeof normalized.to === "string" && typeof normalized.recipient !== "string") normalized.recipient = normalized.to;
  const requestedLimit = typeof normalized.limit === "number" && Number.isFinite(normalized.limit)
    ? Math.floor(normalized.limit)
    : ACTION_MAIL_SEARCH_PAGE_SIZE;
  normalized.limit = Math.min(Math.max(requestedLimit, 1), ACTION_MAIL_SEARCH_PAGE_SIZE);
  const allowed = new Set([
    "query", "subject", "sender", "recipient", "cc", "senderDomain", "account", "mailbox", "anyMailbox",
    "dateFrom", "dateTo", "unreadOnly", "flaggedOnly", "answeredOnly", "junkOnly", "hasAttachments",
    "attachmentType", "attachmentName", "minSize", "maxSize", "fromName", "fromAddr", "toName",
    "subjectContains", "bodyContains", "sort", "sortDir", "limit", "offset", "perMessage",
  ]);
  return Object.fromEntries(Object.entries(normalized).filter(([key]) => allowed.has(key)));
}

function callKey(call: ReadToolCall): string {
  return `${call.tool}:${stableJson(call.input)}`;
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const obj = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

function compactResult(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
    }
    return v;
  });
  if (!json || json.length <= 6000) return value;
  try {
    return JSON.parse(json.slice(0, 6000));
  } catch {
    return `${json.slice(0, 6000)}…`;
  }
}
