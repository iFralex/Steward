import { cleanBody } from "../../mail-promoter/src/clean-body.ts";
import type { Chat } from "./llm.ts";
import { jsonFromLlm } from "./llm.ts";
import type { ActionKind, ActionPriority, ContextSnapshot, FlowMatch, ProposedAction, ProposedManualStep, ProposedToolStep, RelatedActionCandidate } from "./types.ts";
import { lookupCalendarContext, lookupContactContext, lookupWikiContext, type CalendarContext } from "./context.ts";
import { collectReadToolContext, isAllowedReadTool, type ReadToolExecutor } from "./tool-context.ts";
import { flowQuery } from "./flows.ts";

export interface PlanningMessage {
  messageId: string;
  threadId: number | null;
  fromName: string;
  fromAddr: string;
  to: string[];
  cc: string[];
  subject: string;
  date: number;
  bodyText: string;
  mailbox: string;
}

export interface PlannedActionCard {
  kind: ActionKind;
  priority: ActionPriority;
  title: string;
  summary: string;
  dueAt: number | null;
  deadline: { dueAt: number | null; iso: string | null; estimated: boolean };
  contextSnapshot: ContextSnapshot;
  proposedActions: ProposedAction[];
  needsAction: boolean;
  relatedActionId: number | null;
}

const ANALYZE_SYSTEM = `You are the intelligence layer for Alessio's personal action center.
Analyze the email and decide whether it creates an actionable item.
Infer all scheduling details from the conversation context itself: proposed times, duration, timezone, meeting link, participants, and reasonable alternatives.
Return ONLY JSON:
{
  "needsAction": boolean,
  "kind": "reply-needed"|"scheduling-request"|"calendar-invite"|"deadline"|"document-action"|"follow-up"|"admin-task",
  "priority": "low"|"normal"|"high",
  "summary": string,
  "dueDateTime": ISO string|null,
  "scheduling": {
    "requestedSlots": [{"start": ISO string, "end": ISO string}],
    "meetingTitle": string|null,
    "meetingLink": string|null,
    "calendarName": string|null
  }|null,
  "replyDrafts": {
    "accept": string|null,
    "decline": string|null,
    "proposeAlternative": string|null,
    "askClarification": string|null
  },
  "reasoning": string
}
Rules:
- If someone asks whether Alessio is free, available, can join a call/meeting/interview, or proposes a time, use kind="scheduling-request".
- MatchingFlows contains user-authored workflow candidates retrieved for this exact message. A strong match may make an otherwise informational message actionable because the user explicitly wants the described follow-up. Apply the same when/exclusions checks; do not make weak matches actionable.
- A matching flow is a preference, not evidence. Never copy dates, recipients, accessibility needs, or other facts from it unless the current message or later validated tool context supplies them.
- For scheduling, requestedSlots must include concrete ISO intervals when the email contains or implies enough information; infer duration from the email or use a reasonable duration from the context.
- Drafts should be ready to send, in the likely language/tone of the thread.
- Do not execute anything.`;

const PLAN_SYSTEM = `You turn an analyzed action item plus context into useful proposed courses of action for Alessio.
Return ONLY JSON:
{"title": string, "summary": string, "relatedActionId": number|null, "appliedFlowIds": [number], "proposedActions": [
  {"id": string, "label": string, "summary": string, "confidence": "low"|"medium"|"high",
   "steps": [{"id": string, "label": string, "kind": "tool"|"manual", "tool": string|null, "input": object|null, "writes": boolean|null, "links": [{"url": string, "label": string|null}]|null}]}
]}.
Available write tools:
- mcp__mail__reply with {messageId, from, body, replyAll}
- mcp__mail__send_email with {to, cc, subject, body}
- mcp__calendar__create_event with {calendar, summary, start, end, location, description, url, alarms}
Available read tools for later chat refinement:
- mcp__mail__get_thread, mcp__contacts__search_contacts, mcp__llm-wiki__llm_wiki_search, mcp__calendar__search_events
Rules:
- A proposed action is a distinct course of action or decision, not a generic checklist variant. Usually return one recommended course; include alternatives only when they lead to meaningfully different outcomes.
- Steps are the necessary sequence for completing that course. A step may be manual when Alessio must act outside the available tools. Do not turn every screen, click, check, or piece of advice into a separate step: combine adjacent navigation into one concise, outcome-oriented manual step.
- Preserve useful initiative, but ground every extra step or alternative in the source or validated context. A reminder is useful only when timing materially affects completion; a prepared editable message is useful only when missing information blocks or materially changes the decision. Do not add generic checks, advice, or tool usage merely to make the proposal look more complete.
- Keep each proposal focused on the requested outcome. Do not broaden the task into optional adjacent work unless that work is required to complete it.
- Timing alternatives are meaningful only when they change feasibility and both are supported by source data, calendar availability, known operating constraints, or other validated context. Never assume availability or opening hours. When the needed timing information is unknown, omit the time-specific option or propose a concise clarification instead.
- Do not repeat the card's common goal as an identical manual step in every alternative. If alternatives differ only by reminder date, their calendar tool step is enough; the card title already states the task to perform.
- Passive outcomes such as ignoring, archiving, waiting, staying reachable, or doing nothing are not proposed actions unless the user must actively communicate or configure something.
- Financial, security, legal, and account actions may be proposed when the source explicitly supports them. Keep consequential actions conditional on first verifying the current state through an official channel; never turn an unverified alert into an unconditional transfer, trade, credential change, or account operation.
- Use exact facts from the message and validated context. Never invent event hours, deadlines, amounts, accessibility needs, or personal preferences. When material information is missing, a distinct option may ask the sender only for the concrete details needed to decide or execute; prepare a concise editable email. Otherwise say what is unknown and avoid a tool action that requires it.
- For an event or commitment, if the date, time, location, registration deadline, or other material logistics are missing and could change the decision, include a distinct clarification option with a concise editable email. A provisional all-day calendar hold may coexist with that option; do not present the hold as confirmed event timing.
- currentTime is authoritative and includes the computer's current local time and system time zone. Never create or suggest a calendar event whose start is before currentTime. If a previously sensible reminder time has passed, choose a future suggestion or omit the reminder; never rewrite the source deadline or call a local-today time "tomorrow" because its UTC date differs.
- Keep labels concise and put supporting detail in the proposal summary or tool input. Prefer roughly 1-3 proposals and 1-3 steps per proposal, but completeness is more important than a rigid count.
- Read-only tool observations, if present in contextSnapshot.toolContext, have already been executed. Do not propose read-only steps merely to gather that same data; use those observations to produce validated write actions or explain uncertainty.
- contextSnapshot.flows contains at most two user-authored workflow candidates retrieved for this situation. Apply a flow only when its "when" condition fits the actual message and none of its exclusions apply. Its guidance is a preference, not evidence: use exact dates, addresses, journey details, recipients, and other facts only from the message or validated read-tool observations. Never force a weak match.
- If a flow is materially used, include its id in appliedFlowIds and say briefly in the Action summary that the proposal follows that named flow. If no flow is used, return an empty appliedFlowIds array. Do not expose retrieval scores or claim that a flow ran automatically.
- A flow may require preparatory read-tool research. Use validated observations already present in toolContext; if a required fact is still missing, make the relevant step editable/conditional or omit it rather than inventing it. Flows never authorize execution: all write steps remain proposals requiring approval.
- Proposed action steps must be executable user actions only. Do not include read-only tools in proposedActions.
- Treat contextSnapshot.mail.replyRequirements as hard completeness requirements for reply/send-email proposals. A proposal that replies to the email must cover each requirement in the body, even when it offers alternatives.
- If the current thread asks for multiple pieces of information, every reply proposal must address all of them. Do not narrow the action to only the latest detail. For example, if a thread asks for both monthly attendance/presences and how to account for a specific bridge/holiday day, the reply must include both the attendance/presence statement and the specific accounting choice for that day.
- Treat contextSnapshot.mail.relatedMailFacts as validated facts. If it says Alessio already communicated absence/presence information in another thread, do not say he has not replied at all; frame the proposed reply as a follow-up/integration that acknowledges the earlier message and adds only the missing detail.
- If read-only observations show the user already sent a related answer in another thread, draft the final action as a concise follow-up/update that acknowledges the earlier message and adds the missing information when appropriate.
- When historical messages are consulted as examples, reuse only stable information that the flow explicitly asks for, such as a verified recipient address or general message structure. Never copy an old trip's station, date, time, train, booking code, passenger, assistance details, amount, account state, or other case-specific fact into the current Action. Current-source facts always win, including exact station variants.
- When an applicable flow already defines a coherent sequence, normally return one course containing that sequence. Do not add a "do it later", partial, or reminder-only alternative merely to create choice. Add an alternative only for a real decision supported by current facts.
- If requested slot is available, include an accept+create-calendar option.
- If requested slot is busy, include a decline/propose-alternative option.
- Calendar alarms must be numbers: minutes before event start, e.g. [15], not objects.
- Calendar names must be real calendar names when known; avoid placeholders like "primary".
- Do not propose forwarding/copying notifications to Alessio unless explicitly useful.
- Use kind:"manual" for a step that requires Alessio to open an external link himself because no automation tool exists for it (e.g. uploading a document to a web portal, clicking a provided connection/registration/confirmation link). Manual steps must omit tool/input/writes and set links instead.
- A manual step's links[].url must be copied verbatim from a URL that literally appears in the email content below. Never invent, guess, or complete a partial URL. If you are not certain of the exact URL, omit links entirely — the step's label alone still tells Alessio what to do.
- When a manual step says to open, register, download, inspect, confirm, or accept something and the matching URL is present in the email, include that URL in links. Do not make Alessio search the message manually when the source already provides a safe direct link.
- relatedOpenActions contains open Actions from the same correspondent domain. Set relatedActionId only when this email is a later notification or continuation of the same concrete issue, account event, request, transaction, or event. Same sender/domain or a similar generic subject is not enough. When relatedActionId is set, rewrite title and summary as the current chronological state, preserving relevant earlier facts and clearly stating what changed. Otherwise return null.
- The host will guard all write tools, so output concrete executable inputs.
- Preserve uncertainty in summaries, but keep tool inputs usable.`;

export async function planMailAction(msg: PlanningMessage, chat: Chat, opts: { userAddrs?: string[]; readTool?: ReadToolExecutor; relatedOpenActions?: RelatedActionCandidate[]; flowSearch?: (query: string, limit: number) => Promise<FlowMatch[]>; now?: Date } = {}): Promise<PlannedActionCard | null> {
  const now = opts.now ?? new Date();
  const flows = opts.flowSearch ? await opts.flowSearch(flowQuery(msg, {}), 2).catch(() => []) : [];
  const analyzed = await analyzeMail(msg, chat, opts.userAddrs ?? [], now, flows);
  if (!analyzed?.needsAction) return null;

  const slots = analyzed.scheduling?.requestedSlots ?? [];
  const calendar = lookupCalendarContext(slots);
  const contacts = lookupContactContext({ fromName: msg.fromName, fromAddr: msg.fromAddr });
  const wikiQuery = [msg.fromName, msg.fromAddr.split("@").at(-1), msg.subject].filter(Boolean).join(" ");
  const wiki = await lookupWikiContext(wikiQuery);
  const dueAt = analyzed.dueDateTime && Number.isFinite(Date.parse(analyzed.dueDateTime))
    ? Math.floor(Date.parse(analyzed.dueDateTime) / 1000)
    : firstSlotStart(analyzed.scheduling?.requestedSlots) ?? null;
  const deadline = {
    dueAt,
    iso: dueAt ? new Date(dueAt * 1000).toISOString() : null,
    estimated: dueAt != null,
  };
  const toolContext = await collectReadToolContext({
    chat,
    execute: opts.readTool,
    message: {
      messageId: msg.messageId,
      threadId: msg.threadId,
      from: msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr,
      to: msg.to,
      cc: msg.cc,
      subject: msg.subject,
      date: new Date(msg.date * 1000).toISOString(),
      bodyPreview: cleanBody(msg.bodyText).slice(0, 2500),
    },
    analyzed: { ...analyzed, deadline },
    flows,
    referenceTime: now,
  });
  const replyRequirements: string[] = [];
  const relatedMailFacts = deriveRelatedMailFacts(toolContext, opts.userAddrs ?? [], msg.date);
  const contextSnapshot: ContextSnapshot = {
    mail: {
      messageId: msg.messageId,
      threadId: msg.threadId,
      from: msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr,
      to: msg.to,
      cc: msg.cc,
      subject: msg.subject,
      date: new Date(msg.date * 1000).toISOString(),
      replyDrafts: analyzed.replyDrafts,
      scheduling: analyzed.scheduling,
      deadline,
      replyRequirements,
      relatedMailFacts,
    },
    calendar: { ...calendar },
    contacts: { ...contacts },
    wiki,
    toolContext,
    flows,
    reasoning: analyzed.reasoning,
  };

  const planned = await planActions(msg, analyzed, contextSnapshot, calendar, opts.relatedOpenActions ?? [], chat, now);
  if (planned) contextSnapshot.flows = flows.filter((flow) => planned.appliedFlowIds.includes(flow.id));

  return {
    kind: analyzed.kind,
    priority: analyzed.priority,
    title: planned?.title ?? defaultTitle(analyzed.kind, msg.subject),
    summary: planned?.summary ?? analyzed.summary,
    dueAt,
    deadline,
    contextSnapshot,
    proposedActions: planned?.proposedActions ?? fallbackActions(msg, analyzed, calendar),
    needsAction: true,
    relatedActionId: planned?.relatedActionId ?? null,
  };
}

function deriveRelatedMailFacts(
  toolContext: { requested: unknown[]; observations: unknown[] },
  userAddrs: string[],
  referenceDate: number,
): Record<string, unknown>[] {
  const userSet = new Set(userAddrs.map((a) => a.toLowerCase()));
  const facts: Record<string, unknown>[] = [];
  for (const message of extractMailSummaries(toolContext.observations)) {
    const from = String(message.from ?? "").toLowerCase();
    const snippet = String(message.snippet ?? "");
    const subject = String(message.subject ?? "");
    const sentByUser = [...userSet].some((addr) => from.includes(addr));
    if (!sentByUser) continue;
    if (!isNearReferenceDate(message.date, referenceDate)) continue;
    if (/\b(nulla da segnalare|nessuna? assenz|non ho assenz|no assenz|nothing to report|no absence)/i.test(snippet)) {
      facts.push({
        kind: "already-replied-elsewhere",
        meaning: "The user already answered this request in another recent thread.",
        subject,
        date: message.date,
        threadId: message.threadId,
        mailUrl: message.mailUrl,
        snippet: snippet.slice(0, 500),
      });
    }
  }
  return uniqueFacts(facts);
}

function isNearReferenceDate(value: unknown, referenceDate: number): boolean {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return true;
  const date = Math.floor(Date.parse(value) / 1000);
  return Math.abs(date - referenceDate) <= 45 * 86400;
}

function extractMailSummaries(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (v == null) return;
    if (typeof v === "string") {
      const trimmed = v.trim();
      if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
        try {
          visit(JSON.parse(trimmed));
        } catch {
          // Ignore non-JSON strings.
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v !== "object") return;
    const obj = v as Record<string, unknown>;
    if (typeof obj.text === "string") visit(obj.text);
    if (typeof obj.id === "string" || typeof obj.messageId === "string" || typeof obj.mailUrl === "string") out.push(obj);
    for (const item of Object.values(obj)) {
      if (item !== obj.text) visit(item);
    }
  };
  visit(value);
  return out;
}

function uniqueFacts(facts: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const fact of facts) {
    const key = `${fact.kind}:${fact.mailUrl ?? fact.subject}:${fact.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out.slice(0, 5);
}

async function analyzeMail(msg: PlanningMessage, chat: Chat, userAddrs: string[], now: Date, flows: FlowMatch[]): Promise<AnalyzedMail | null> {
  const body = cleanBody(msg.bodyText).slice(0, 9000);
  const out = await chat(ANALYZE_SYSTEM, [
    `Today: ${now.toISOString()}`,
    userAddrs.length ? `Alessio addresses: ${userAddrs.join(", ")}` : "",
    `From: ${msg.fromName} <${msg.fromAddr}>`,
    `To: ${msg.to.join(", ")}`,
    `Cc: ${msg.cc.join(", ")}`,
    `Subject: ${msg.subject}`,
    `Date: ${new Date(msg.date * 1000).toISOString()}`,
    flows.length ? `MatchingFlows: ${JSON.stringify(flows)}` : "",
    "",
    body,
  ].filter(Boolean).join("\n"));
  const parsed = jsonFromLlm<Record<string, unknown>>(out);
  if (!parsed || typeof parsed.needsAction !== "boolean") return null;
  return normalizeAnalyzed(parsed);
}

async function planActions(
  msg: PlanningMessage,
  analyzed: AnalyzedMail,
  contextSnapshot: ContextSnapshot,
  calendar: CalendarContext,
  relatedOpenActions: RelatedActionCandidate[],
  chat: Chat,
  now: Date,
): Promise<{ title: string; summary: string; proposedActions: ProposedAction[]; relatedActionId: number | null; appliedFlowIds: number[] } | null> {
  const out = await chat(PLAN_SYSTEM, JSON.stringify({ message: {
    messageId: msg.messageId,
    subject: msg.subject,
    from: msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr,
    bodyText: msg.bodyText,
  }, currentTime: currentTimeContext(now), analyzed, contextSnapshot, calendar, relatedOpenActions }, null, 2));
  const parsed = jsonFromLlm<Record<string, unknown>>(out);
  if (!parsed) return null;
  const proposedActions = normalizeProposedActions(parsed.proposedActions, analyzed, msg.bodyText);
  if (!proposedActions.length) return null;
  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : defaultTitle(analyzed.kind, msg.subject),
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : analyzed.summary,
    proposedActions,
    relatedActionId: normalizeRelatedActionId(parsed.relatedActionId, relatedOpenActions),
    appliedFlowIds: normalizeAppliedFlowIds(parsed.appliedFlowIds, contextSnapshot.flows ?? []),
  };
}

function currentTimeContext(now = new Date()): { iso: string; local: string; timeZone: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    iso: now.toISOString(),
    local: new Intl.DateTimeFormat("sv-SE", {
      dateStyle: "short",
      timeStyle: "medium",
      hour12: false,
    }).format(now),
    timeZone,
  };
}

function normalizeAppliedFlowIds(value: unknown, candidates: FlowMatch[]): number[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(candidates.map((flow) => flow.id));
  return [...new Set(value.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && allowed.has(id)))];
}

function normalizeRelatedActionId(value: unknown, candidates: RelatedActionCandidate[]): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && candidates.some((candidate) => candidate.id === value)
    ? value
    : null;
}

interface AnalyzedMail {
  needsAction: boolean;
  kind: ActionKind;
  priority: ActionPriority;
  summary: string;
  dueDateTime: string | null;
  scheduling: {
    requestedSlots: { start: string; end: string }[];
    meetingTitle: string | null;
    meetingLink: string | null;
    calendarName: string | null;
  } | null;
  replyDrafts: Record<"accept" | "decline" | "proposeAlternative" | "askClarification", string | null>;
  reasoning: string;
}

function normalizeAnalyzed(p: Record<string, unknown>): AnalyzedMail {
  const kind = ["reply-needed", "scheduling-request", "calendar-invite", "deadline", "document-action", "follow-up", "admin-task"].includes(String(p.kind))
    ? p.kind as ActionKind
    : "reply-needed";
  const priority = p.priority === "high" || p.priority === "low" ? p.priority : "normal";
  const scheduling = p.scheduling && typeof p.scheduling === "object"
    ? p.scheduling as Record<string, unknown>
    : null;
  const requestedSlots = Array.isArray(scheduling?.requestedSlots)
    ? scheduling.requestedSlots
        .map((s) => s && typeof s === "object" ? s as Record<string, unknown> : null)
        .filter((s): s is Record<string, unknown> => !!s)
        .map((s) => ({ start: String(s.start ?? ""), end: String(s.end ?? "") }))
        .filter((s) => Number.isFinite(Date.parse(s.start)) && Number.isFinite(Date.parse(s.end)))
    : [];
  const drafts = p.replyDrafts && typeof p.replyDrafts === "object" ? p.replyDrafts as Record<string, unknown> : {};
  return {
    needsAction: p.needsAction === true,
    kind,
    priority,
    summary: typeof p.summary === "string" && p.summary.trim() ? p.summary.trim() : "Action required",
    dueDateTime: typeof p.dueDateTime === "string" && Number.isFinite(Date.parse(p.dueDateTime)) ? p.dueDateTime : null,
    scheduling: scheduling ? {
      requestedSlots,
      meetingTitle: typeof scheduling.meetingTitle === "string" ? scheduling.meetingTitle : null,
      meetingLink: typeof scheduling.meetingLink === "string" ? scheduling.meetingLink : null,
      calendarName: typeof scheduling.calendarName === "string" ? scheduling.calendarName : null,
    } : null,
    replyDrafts: {
      accept: strOrNull(drafts.accept),
      decline: strOrNull(drafts.decline),
      proposeAlternative: strOrNull(drafts.proposeAlternative),
      askClarification: strOrNull(drafts.askClarification),
    },
    reasoning: typeof p.reasoning === "string" ? p.reasoning : "",
  };
}

function normalizeProposedActions(value: unknown, analyzed: AnalyzedMail | undefined, rawBodyText: string): ProposedAction[] {
  if (!Array.isArray(value)) return [];
  return value.map((a, index) => {
    if (!a || typeof a !== "object") return null;
    const obj = a as Record<string, unknown>;
    const steps = Array.isArray(obj.steps)
      ? obj.steps
          .map((s, sIndex) => normalizeProposedStep(s, sIndex, analyzed, rawBodyText))
          .filter((s): s is ProposedToolStep | ProposedManualStep => !!s)
      : [];
    if (!steps.length) return null;
    return {
      id: typeof obj.id === "string" ? obj.id : `action-${index + 1}`,
      label: typeof obj.label === "string" ? obj.label : `Option ${index + 1}`,
      summary: typeof obj.summary === "string" ? obj.summary : "",
      confidence: obj.confidence === "low" || obj.confidence === "medium" ? obj.confidence : "high",
      steps,
    };
  }).filter((a): a is ProposedAction => !!a);
}

function normalizeProposedStep(
  raw: unknown,
  index: number,
  analyzed: AnalyzedMail | undefined,
  rawBodyText: string,
): ProposedToolStep | ProposedManualStep | null {
  if (!raw || typeof raw !== "object") return null;
  const step = raw as Record<string, unknown>;
  if (step.kind === "manual") {
    const normalizedLinks = normalizeManualLinks(step.links, rawBodyText);
    return {
      id: typeof step.id === "string" ? step.id : `step-${index + 1}`,
      label: typeof step.label === "string" ? step.label : "Manual step",
      kind: "manual",
      links: normalizedLinks.length > 0 ? normalizedLinks : inferSinglePlainWebLink(step.label, rawBodyText),
    };
  }
  if (typeof step.tool !== "string" || !step.tool.startsWith("mcp__")) return null;
  if (isAllowedReadTool(step.tool)) return null;
  const input = normalizeToolInput(
    step.tool,
    step.input && typeof step.input === "object" && !Array.isArray(step.input) ? step.input as Record<string, unknown> : {},
    analyzed,
  );
  return {
    id: typeof step.id === "string" ? step.id : `step-${index + 1}`,
    label: typeof step.label === "string" ? step.label : step.tool,
    kind: "tool",
    tool: step.tool,
    input,
    writes: step.writes !== false,
  };
}

function inferSinglePlainWebLink(label: unknown, rawBodyText: string): { url: string }[] {
  if (typeof label !== "string" || !/\b(apri|acced|scaric|consult|open|access|download|visit)\w*/i.test(label)) return [];
  const matches = [...rawBodyText.matchAll(/\bwww\.[a-z0-9.-]+(?:\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?/gi)]
    .map((match) => match[0].replace(/[.,;:!?]+$/, ""));
  const unique = [...new Set(matches)];
  return unique.length === 1 ? [{ url: `https://${unique[0]}` }] : [];
}

function normalizeManualLinks(value: unknown, rawBodyText: string): { url: string; label?: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { url: string; label?: string }[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Record<string, unknown>;
    if (typeof l.url !== "string" || !l.url.trim()) continue;
    const sourceUrl = l.url.trim();
    if (!rawBodyText.includes(sourceUrl)) continue;
    const url = /^https?:\/\//i.test(sourceUrl)
      ? sourceUrl
      : /^www\.[a-z0-9.-]+(?:[/?#][^\s]*)?$/i.test(sourceUrl)
        ? `https://${sourceUrl}`
        : null;
    if (!url) continue;
    out.push(typeof l.label === "string" && l.label.trim() ? { url, label: l.label.trim() } : { url });
  }
  return out;
}

function normalizeToolInput(tool: string, input: Record<string, unknown>, analyzed?: AnalyzedMail): Record<string, unknown> {
  if (tool === "mcp__calendar__create_event") {
    const out = { ...input };
    const calendar = typeof out.calendar === "string" ? out.calendar.trim() : "";
    if ((!calendar || /^primary$/i.test(calendar) || /^calendar$/i.test(calendar)) && analyzed?.scheduling?.calendarName) {
      out.calendar = analyzed.scheduling.calendarName;
    }
    out.alarms = normalizeAlarms(out.alarms);
    for (const field of ["summary", "start", "end", "location", "description", "url"]) {
      if (out[field] == null) delete out[field];
    }
    return out;
  }
  if (tool === "mcp__calendar__update_event") {
    const out = { ...input };
    if ("alarms" in out) out.alarms = normalizeAlarms(out.alarms);
    return out;
  }
  if (tool === "mcp__mail__send_email") {
    const out = { ...input };
    for (const field of ["to", "cc", "bcc", "attachments"]) {
      if (typeof out[field] === "string") out[field] = [out[field]];
    }
    return out;
  }
  return input;
}

function normalizeAlarms(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const raw = typeof obj.trigger === "number" ? obj.trigger : typeof obj.minutes === "number" ? obj.minutes : null;
        if (raw == null || !Number.isFinite(raw)) return null;
        // Some models emit seconds in {trigger}; MCP expects minutes before start.
        return Math.abs(raw) > 180 ? Math.round(Math.abs(raw) / 60) : Math.abs(raw);
      }
      return null;
    })
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0)
    .map((n) => Math.round(n));
}

function fallbackActions(msg: PlanningMessage, analyzed: AnalyzedMail, calendar: CalendarContext): ProposedAction[] {
  const actions: ProposedAction[] = [];
  const slot = analyzed.scheduling?.requestedSlots[0];
  const available = calendar.requestedSlots[0]?.available;
  if (analyzed.kind === "scheduling-request" && slot && available && analyzed.replyDrafts.accept) {
    actions.push({
      id: "accept-and-create-event",
      label: "Accept and create calendar event",
      summary: "Reply that Alessio is available and create the calendar event.",
      confidence: "medium",
      steps: [
        { id: "reply", label: "Send acceptance reply", tool: "mcp__mail__reply", input: { messageId: msg.messageId, body: analyzed.replyDrafts.accept, replyAll: true }, writes: true },
        { id: "calendar", label: "Create calendar event", tool: "mcp__calendar__create_event", input: {
          calendar: analyzed.scheduling?.calendarName ?? "Calendar",
          summary: analyzed.scheduling?.meetingTitle ?? msg.subject,
          start: slot.start,
          end: slot.end,
          location: analyzed.scheduling?.meetingLink ?? undefined,
          url: analyzed.scheduling?.meetingLink ?? undefined,
          description: `Created from email ${msg.messageId}`,
          alarms: [15],
        }, writes: true },
      ],
    });
  }
  const body = analyzed.replyDrafts.proposeAlternative ?? analyzed.replyDrafts.decline ?? analyzed.replyDrafts.askClarification;
  if (body) {
    actions.push({
      id: "reply-only",
      label: available === false ? "Decline or propose another time" : "Reply only",
      summary: "Send a reply without creating a calendar event.",
      confidence: "medium",
      steps: [{ id: "reply", label: "Send reply", tool: "mcp__mail__reply", input: { messageId: msg.messageId, body, replyAll: true }, writes: true }],
    });
  }
  return actions;
}

function firstSlotStart(slots?: { start: string; end: string }[]): number | null {
  const start = slots?.[0]?.start;
  if (!start) return null;
  const ms = Date.parse(start);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function defaultTitle(kind: ActionKind, subject: string): string {
  return kind === "scheduling-request" ? `Scheduling: ${subject || "(no subject)"}` : `Action: ${subject || "(no subject)"}`;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
