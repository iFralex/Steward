import { cleanBody } from "../../mail-promoter/src/clean-body.ts";
import type { Chat } from "./llm.ts";
import { jsonFromLlm } from "./llm.ts";
import type { ActionKind, ActionPriority, ContextSnapshot, ProposedAction } from "./types.ts";
import { lookupCalendarContext, lookupContactContext, lookupWikiContext, type CalendarContext } from "./context.ts";

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
  contextSnapshot: ContextSnapshot;
  proposedActions: ProposedAction[];
  needsAction: boolean;
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
- For scheduling, requestedSlots must include concrete ISO intervals when the email contains or implies enough information; infer duration from the email or use a reasonable duration from the context.
- Drafts should be ready to send, in the likely language/tone of the thread.
- Do not execute anything.`;

const PLAN_SYSTEM = `You turn an analyzed action item plus context into executable proposed actions for Alessio.
Return ONLY JSON:
{"title": string, "summary": string, "proposedActions": [
  {"id": string, "label": string, "summary": string, "confidence": "low"|"medium"|"high",
   "steps": [{"id": string, "label": string, "tool": string, "input": object, "writes": boolean}]}
]}.
Available write tools:
- mcp__mail__reply with {messageId, body, replyAll}
- mcp__mail__send_email with {to, cc, subject, body}
- mcp__calendar__create_event with {calendar, summary, start, end, location, description, url, alarms}
Available read tools for later chat refinement:
- mcp__mail__get_thread, mcp__contacts__search_contacts, mcp__llm-wiki__llm_wiki_search, mcp__calendar__search_events
Rules:
- Include multiple realistic alternatives when useful.
- If requested slot is available, include an accept+create-calendar option.
- If requested slot is busy, include a decline/propose-alternative option.
- The host will guard all write tools, so output concrete executable inputs.
- Preserve uncertainty in summaries, but keep tool inputs usable.`;

export async function planMailAction(msg: PlanningMessage, chat: Chat, opts: { userAddrs?: string[] } = {}): Promise<PlannedActionCard | null> {
  const analyzed = await analyzeMail(msg, chat, opts.userAddrs ?? []);
  if (!analyzed?.needsAction) return null;

  const slots = analyzed.scheduling?.requestedSlots ?? [];
  const calendar = lookupCalendarContext(slots);
  const contacts = lookupContactContext({ fromName: msg.fromName, fromAddr: msg.fromAddr });
  const wikiQuery = [msg.fromName, msg.fromAddr.split("@").at(-1), msg.subject].filter(Boolean).join(" ");
  const wiki = await lookupWikiContext(wikiQuery);
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
    },
    calendar: { ...calendar },
    contacts: { ...contacts },
    wiki,
    reasoning: analyzed.reasoning,
  };

  const planned = await planActions(msg, analyzed, contextSnapshot, calendar, chat);
  const dueAt = analyzed.dueDateTime && Number.isFinite(Date.parse(analyzed.dueDateTime))
    ? Math.floor(Date.parse(analyzed.dueDateTime) / 1000)
    : firstSlotStart(analyzed.scheduling?.requestedSlots) ?? null;

  return {
    kind: analyzed.kind,
    priority: analyzed.priority,
    title: planned?.title ?? defaultTitle(analyzed.kind, msg.subject),
    summary: planned?.summary ?? analyzed.summary,
    dueAt,
    contextSnapshot,
    proposedActions: planned?.proposedActions ?? fallbackActions(msg, analyzed, calendar),
    needsAction: true,
  };
}

async function analyzeMail(msg: PlanningMessage, chat: Chat, userAddrs: string[]): Promise<AnalyzedMail | null> {
  const body = cleanBody(msg.bodyText).slice(0, 9000);
  const out = await chat(ANALYZE_SYSTEM, [
    `Today: ${new Date().toISOString()}`,
    userAddrs.length ? `Alessio addresses: ${userAddrs.join(", ")}` : "",
    `From: ${msg.fromName} <${msg.fromAddr}>`,
    `To: ${msg.to.join(", ")}`,
    `Cc: ${msg.cc.join(", ")}`,
    `Subject: ${msg.subject}`,
    `Date: ${new Date(msg.date * 1000).toISOString()}`,
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
  chat: Chat,
): Promise<{ title: string; summary: string; proposedActions: ProposedAction[] } | null> {
  const out = await chat(PLAN_SYSTEM, JSON.stringify({ message: {
    messageId: msg.messageId,
    subject: msg.subject,
    from: msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr,
  }, analyzed, contextSnapshot, calendar }, null, 2));
  const parsed = jsonFromLlm<Record<string, unknown>>(out);
  if (!parsed) return null;
  const proposedActions = normalizeProposedActions(parsed.proposedActions);
  if (!proposedActions.length) return null;
  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : defaultTitle(analyzed.kind, msg.subject),
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : analyzed.summary,
    proposedActions,
  };
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

function normalizeProposedActions(value: unknown): ProposedAction[] {
  if (!Array.isArray(value)) return [];
  return value.map((a, index) => {
    if (!a || typeof a !== "object") return null;
    const obj = a as Record<string, unknown>;
    const steps = Array.isArray(obj.steps)
      ? obj.steps.map((s, sIndex) => {
          if (!s || typeof s !== "object") return null;
          const step = s as Record<string, unknown>;
          if (typeof step.tool !== "string" || !step.tool.startsWith("mcp__")) return null;
          return {
            id: typeof step.id === "string" ? step.id : `step-${sIndex + 1}`,
            label: typeof step.label === "string" ? step.label : step.tool,
            tool: step.tool,
            input: step.input && typeof step.input === "object" && !Array.isArray(step.input) ? step.input as Record<string, unknown> : {},
            writes: step.writes !== false,
          };
        }).filter((s): s is NonNullable<typeof s> => !!s)
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
