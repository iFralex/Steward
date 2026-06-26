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
  "mcp__mail__get_thread with {threadId? number, messageId? string, id? string}",
  "mcp__mail__read_message with {messageId? string, id? string}",
  "mcp__mail__search_messages with {query? string, from? string, to? string, subject? string, since? string, until? string, limit? number}",
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

const TOOL_CONTEXT_SYSTEM = `You decide which read-only tools should be called before creating an Action Center item.
Return ONLY JSON:
{"toolCalls":[{"tool": string, "input": object, "reason": string}]}.
Available read-only tools:
${READ_TOOL_SPECS.map((s) => `- ${s}`).join("\n")}
Rules:
- Call tools only when they can materially validate or enrich the proposed action.
- Prefer precise calls: exact threadId/messageId, concrete calendar ranges, concrete contact names/domains.
- For scheduling, availability, absences, deadlines, events, or reminders, use calendar tools when useful.
- For sender identity or recipient ambiguity, use contacts tools when useful.
- For project/document/personal-memory context, use LLM Wiki tools when useful.
- For thread ambiguity, use mail thread/message tools when useful.
- If previous observations reveal new facts that need validation, request additional read tools.
- Do not repeat calls already present in previous observations.
- Do not call write tools. Do not include unavailable tools. Maximum 4 calls total.`;

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
  const maxCalls = args.maxCalls ?? 4;
  const seen = new Set<string>();

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
    out.push({
      tool: obj.tool,
      input: obj.input && typeof obj.input === "object" && !Array.isArray(obj.input) ? obj.input as Record<string, unknown> : {},
      reason: typeof obj.reason === "string" ? obj.reason : "",
    });
    if (out.length >= maxCalls) break;
  }
  return out;
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
