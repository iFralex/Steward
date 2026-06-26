import type { Store, MessageRow } from "../../mail-mirror/src/store.ts";
import type { ActionStore } from "./store.ts";
import type { Chat } from "./llm.ts";
import { planMailAction } from "./planner.ts";
import type { ReadToolExecutor } from "./tool-context.ts";

const NO_REPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer|newsletter|bounce|postmaster)\b/i;
const LOW_VALUE_SURVEY = /\b(survey|questionario|soddisfazione|feedback|post[-\s]?result survey)\b/i;

export interface MailScanResult {
  considered: number;
  created: number;
  updated: number;
  skipped: number;
  deferred: number;
  deferredReasons: Record<string, number>;
}

export async function scanMailForActions(deps: {
  mail: Store;
  actions: ActionStore;
  chat: Chat;
  now?: number;
  recentDays?: number;
  limit?: number;
  userAddrs?: string[];
  readTool?: ReadToolExecutor;
}): Promise<MailScanResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const since = now - (deps.recentDays ?? 14) * 86400;
  const limit = deps.limit ?? 50;
  const rows = deps.mail.raw.prepare(
    `SELECT * FROM messages
     WHERE deleted=0 AND date>=? AND unread=1 AND answered=0 AND junk=0
       AND length(trim(coalesce(body_text,'')))>0
     ORDER BY date DESC
     LIMIT ?`,
  ).all(since, limit) as Record<string, unknown>[];
  const messages = rows.map(rowToMessageForAction);
  const result: MailScanResult = { considered: messages.length, created: 0, updated: 0, skipped: 0, deferred: 0, deferredReasons: {} };

  for (const msg of messages) {
    if (NO_REPLY.test(msg.fromAddr) || NO_REPLY.test(msg.fromName)) {
      result.skipped++;
      continue;
    }
    if (isLowValueSurvey(msg)) {
      result.skipped++;
      continue;
    }
    let plan: Awaited<ReturnType<typeof planMailAction>>;
    try {
      plan = await planMailAction(msg, deps.chat, { userAddrs: deps.userAddrs, readTool: deps.readTool });
    } catch (err) {
      recordDeferred(result, err instanceof Error ? err.message : String(err));
      plan = null;
    }
    if (!plan) {
      result.deferred++;
      recordDeferred(result, "no-action-or-unparseable");
      continue;
    }
    if (!plan.needsAction) {
      result.skipped++;
      continue;
    }
    const upsert = deps.actions.upsert({
      sourceKey: mailSourceKey(msg),
      sourceKind: "mail",
      kind: plan.kind,
      priority: plan.priority,
      title: plan.title,
      summary: plan.summary,
      dueAt: plan.dueAt,
      payload: {
        messageId: msg.messageId,
        threadId: msg.threadId,
        from: msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr,
        subject: msg.subject,
        date: msg.date,
        mailbox: msg.mailbox,
        deadline: plan.deadline,
        contextSnapshot: plan.contextSnapshot,
        proposedActions: plan.proposedActions,
        chatPrompt: buildActionChatPrompt(plan.title),
      },
    });
    if (upsert.inserted) result.created++;
    else if (upsert.updated) result.updated++;
  }
  return result;
}

interface MessageForAction extends MessageRow { threadId: number | null }

function buildActionChatPrompt(title: string): string {
  return [
    `We are working on this action-center item: ${title}`,
    "Read its context/proposed actions first if available.",
    "Use contacts, calendar, mail and LLM Wiki tools as needed.",
    "When the user chooses or edits a plan, call the relevant mail/calendar tools; the host will ask approval for writes.",
  ].join(" ");
}

function mailSourceKey(msg: Pick<MessageForAction, "messageId" | "threadId">): string {
  return typeof msg.threadId === "number" && Number.isFinite(msg.threadId)
    ? `mail:thread:${msg.threadId}`
    : `mail:${msg.messageId}`;
}

function isLowValueSurvey(msg: MessageForAction): boolean {
  const subject = msg.subject ?? "";
  const from = `${msg.fromName} ${msg.fromAddr}`;
  if (!LOW_VALUE_SURVEY.test(subject) && !LOW_VALUE_SURVEY.test(from)) return false;
  const body = msg.bodyText.slice(0, 1200);
  return /non rispondere|do not reply|unsubscribe|annulla iscrizione|compilare il questionario|fill (out )?the survey/i.test(body)
    || /feedback|survey|questionario|soddisfazione/i.test(subject);
}

function recordDeferred(result: MailScanResult, rawReason: string): void {
  const reason = rawReason
    .replace(/\s+/g, " ")
    .slice(0, 160)
    || "unknown";
  result.deferredReasons[reason] = (result.deferredReasons[reason] ?? 0) + 1;
}

function rowToMessageForAction(m: Record<string, unknown>): MessageForAction {
  return {
    messageId: m.message_id as string,
    account: m.account as string,
    mailbox: (m.mailbox as string) ?? "",
    fromName: (m.from_name as string) ?? "",
    fromAddr: (m.from_addr as string) ?? "",
    to: JSON.parse((m.to_addrs as string) || "[]"),
    cc: JSON.parse((m.cc_addrs as string) || "[]"),
    subject: (m.subject as string) ?? "",
    date: (m.date as number) ?? 0,
    bodyText: (m.body_text as string) ?? "",
    bodyState: (m.body_state as MessageRow["bodyState"]) ?? "none",
    source: (m.source as MessageRow["source"]) ?? "emlx",
    emlxPath: (m.emlx_path as string) ?? null,
    inReplyTo: (m.in_reply_to as string) ?? null,
    references: JSON.parse((m.reference_ids as string) || "[]"),
    gmThrid: (m.gm_thrid as string) ?? null,
    size: (m.size as number) ?? 0,
    toNames: JSON.parse((m.to_names as string) || "[]"),
    ccNames: JSON.parse((m.cc_names as string) || "[]"),
    unread: !!(m.unread as number),
    flagged: !!(m.flagged as number),
    answered: !!(m.answered as number),
    junk: !!(m.junk as number),
    flagColor: (m.flag_color as number) ?? null,
    appleThrid: (m.apple_thrid as number) ?? null,
    threadId: (m.thread_id as number) ?? (m.apple_thrid as number) ?? null,
  };
}
