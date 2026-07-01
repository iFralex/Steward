import type { Store, MessageRow } from "../../mail-mirror/src/store.ts";
import type { ActionStore } from "./store.ts";
import type { Chat } from "./llm.ts";
import { planMailAction } from "./planner.ts";
import type { ReadToolExecutor } from "./tool-context.ts";

const NO_REPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer|newsletter|bounce|postmaster)\b/i;
const LOW_VALUE_SURVEY = /\b(survey|questionario|soddisfazione|feedback|post[-\s]?result survey)\b/i;
/** How many recent messages to pull before filtering out already-seen ones. */
const SCAN_QUERY_LIMIT = 300;

export interface MailScanResult {
  considered: number;
  created: number;
  updated: number;
  skipped: number;
  deferred: number;
  deferredReasons: Record<string, number>;
  /** Set on the first (clean-start) run: how many existing messages were marked seen. */
  seeded?: number;
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
  /** First run: mark the whole current window as already-seen (clean start). */
  seedIfEmpty?: boolean;
  threadId?: number;
}): Promise<MailScanResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const since = now - (deps.recentDays ?? 14) * 86400;
  const limit = deps.limit ?? 50;
  const manual = typeof deps.threadId === "number";
  const seen = deps.actions.loadSeen();

  // Clean start: on first activation mark the whole current window as seen, so we
  // never re-evaluate the existing backlog — only mail arriving from now on.
  if (deps.seedIfEmpty && seen.size === 0 && !manual) {
    const ids = (deps.mail.raw.prepare(
      `SELECT message_id FROM messages
       WHERE deleted=0 AND junk=0 AND date>=? AND length(trim(coalesce(body_text,'')))>0`,
    ).all(since) as { message_id: string }[]).map((r) => r.message_id);
    deps.actions.markSeen(ids);
    return { considered: 0, created: 0, updated: 0, skipped: 0, deferred: 0, deferredReasons: {}, seeded: ids.length };
  }

  // No unread/answered filters: consider ALL recent mail (incl. read, and threads
  // you replied to). The seen-ledger is what prevents re-evaluating the same mail.
  // thread_id is the mirror's canonical thread id — never mix in apple_thrid (a
  // different id namespace that collides across unrelated threads).
  const threadClause = manual ? "AND thread_id=?" : "";
  const params: unknown[] = [since];
  if (manual) params.push(deps.threadId);
  params.push(manual ? limit : SCAN_QUERY_LIMIT);
  const rows = deps.mail.raw.prepare(
    `SELECT * FROM messages
     WHERE deleted=0 AND date>=? ${threadClause} AND junk=0
       AND length(trim(coalesce(body_text,'')))>0
     ORDER BY date DESC
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];
  const messages = rows.map(rowToMessageForAction);
  // Only genuinely new (not-yet-evaluated) messages trigger work; a new reply in
  // an old thread is a new message → re-evaluates (and reopens) that thread.
  const fresh = manual ? messages : messages.filter((m) => !seen.has(m.messageId));
  const candidates = buildThreadCandidates(deps.mail, fresh, deps.userAddrs ?? []).slice(0, limit);
  const result: MailScanResult = { considered: candidates.length, created: 0, updated: 0, skipped: 0, deferred: 0, deferredReasons: {} };

  for (const candidate of candidates) {
    const msg = candidate.message;
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
        triggerMessageId: candidate.trigger.messageId,
        triggerDate: candidate.trigger.date,
        threadMessageIds: candidate.threadMessages.map((m) => m.messageId),
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
  // Mark every message that fed a processed candidate as seen, so it isn't
  // re-evaluated next run (only a new message in the thread will re-trigger it).
  if (!manual) deps.actions.markSeen(candidates.flatMap((c) => c.batchIds));
  return result;
}

interface MessageForAction extends MessageRow { threadId: number | null }
interface ThreadCandidate {
  message: MessageForAction;
  trigger: MessageForAction;
  threadMessages: MessageForAction[];
  /** Ids of the fresh (queried) messages that formed this candidate's thread group. */
  batchIds: string[];
}

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

function buildThreadCandidates(mail: Store, messages: MessageForAction[], userAddrs: string[]): ThreadCandidate[] {
  const groups = new Map<string, MessageForAction[]>();
  for (const msg of messages) {
    const key = mailSourceKey(msg);
    const group = groups.get(key);
    if (group) group.push(msg);
    else groups.set(key, [msg]);
  }
  const candidates: ThreadCandidate[] = [];
  for (const group of groups.values()) {
    const latestTrigger = [...group].sort((a, b) => b.date - a.date)[0];
    const threadMessages = latestTrigger.threadId != null
      ? loadThreadMessages(mail, latestTrigger.threadId)
      : group;
    const representative = chooseRepresentativeMessage(threadMessages, userAddrs) ?? latestTrigger;
    const merged = mergeThreadForPlanning(representative, latestTrigger, threadMessages, userAddrs);
    candidates.push({ message: merged, trigger: latestTrigger, threadMessages, batchIds: group.map((m) => m.messageId) });
  }
  return candidates.sort((a, b) => b.trigger.date - a.trigger.date);
}

function loadThreadMessages(mail: Store, threadId: number): MessageForAction[] {
  // Match by the canonical thread_id only — mixing in apple_thrid conflates two
  // id namespaces and wrongly joins unrelated (often years-old) messages.
  const rows = mail.raw.prepare(
    `SELECT * FROM messages
     WHERE deleted=0 AND junk=0 AND thread_id=?
       AND length(trim(coalesce(body_text,'')))>0
     ORDER BY date ASC`,
  ).all(threadId) as Record<string, unknown>[];
  return rows.map(rowToMessageForAction);
}

function chooseRepresentativeMessage(threadMessages: MessageForAction[], userAddrs: string[]): MessageForAction | null {
  const incoming = threadMessages
    .filter((m) => !isFromUser(m, userAddrs))
    .filter((m) => !NO_REPLY.test(m.fromAddr) && !NO_REPLY.test(m.fromName));
  const requestLike = incoming.filter(isRequestLikeMessage);
  if (requestLike.length) {
    const primaryRequester = requestLike[0].fromAddr.toLowerCase();
    const sameRequester = requestLike.filter((m) => m.fromAddr.toLowerCase() === primaryRequester);
    return sameRequester.sort((a, b) => b.date - a.date)[0] ?? null;
  }
  return [...incoming]
    .sort((a, b) => b.date - a.date)[0] ?? null;
}

function mergeThreadForPlanning(
  representative: MessageForAction,
  trigger: MessageForAction,
  threadMessages: MessageForAction[],
  userAddrs: string[],
): MessageForAction {
  return {
    ...representative,
    date: Math.max(trigger.date, representative.date),
    messageId: representative.messageId,
    bodyText: renderThreadBody(threadMessages, userAddrs),
    unread: threadMessages.some((m) => m.unread),
    answered: threadMessages.every((m) => m.answered),
  };
}

function renderThreadBody(threadMessages: MessageForAction[], userAddrs: string[]): string {
  return [
    "THREAD CONTEXT — analyze the whole thread, not only one message. Newer messages are listed last.",
    ...threadMessages.map((m) => [
      "---",
      `Date: ${new Date(m.date * 1000).toISOString()}`,
      `From: ${m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr}${isFromUser(m, userAddrs) ? " (Alessio/user)" : ""}`,
      `To: ${m.to.join(", ")}`,
      `Subject: ${m.subject}`,
      cleanThreadBody(m.bodyText),
    ].join("\n")),
  ].join("\n\n");
}

function cleanThreadBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 2500);
}

function isFromUser(msg: MessageForAction, userAddrs: string[]): boolean {
  const from = msg.fromAddr.toLowerCase();
  return userAddrs.some((addr) => addr.toLowerCase() === from);
}

function isRequestLikeMessage(msg: MessageForAction): boolean {
  const text = `${msg.subject}\n${msg.bodyText}`.toLowerCase();
  return /\b(chiedo|vi chiedo|dovete|devi|potete|puoi|ricordo|vi ricordo|comunica|comunicare|inviami|inviate|entro|scadenza|deadline|please|can you|could you|required|action required|need you)\b/i.test(text);
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
    // Canonical mirror thread id only (always populated). Never fall back to
    // apple_thrid — it's a different id namespace and collides across threads.
    threadId: (m.thread_id as number) ?? null,
  };
}
