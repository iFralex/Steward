import { createHash } from "node:crypto";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { recordAudit } from "@steward/audit-log";
import type { Store } from "../../mail-mirror/src/store.ts";
import type { PromoteState } from "./state.ts";
import type { Chat } from "./llm.ts";
import type { WikiPromoter } from "./wiki.ts";
import { shouldConsider } from "./prefilter.ts";
import { triage, TRIAGE_POLICY_HASH } from "./triage.ts";
import { buildThreadInput } from "./thread-input.ts";
import { buildNote } from "./note.ts";
import { promote } from "./wiki.ts";
import { attachmentDecisionId, type PromotedAttachment } from "./attachments.ts";
import { buildGteInput, GTE_INPUT_VERSION } from "./gte-input.ts";
import type { MailGate } from "./gte.ts";
import { DeferredChatError, type BatchControl } from "./batch-control.ts";

export interface RunDeps {
  store: Store;
  state: PromoteState;
  chat: Chat;
  wiki: WikiPromoter;
  roleOf: (account: string, mailbox: string) => string | undefined;
  accountLabelOf: (account: string) => string;
  userAddrs?: string[];
  model?: string;
  syncAttachments?: (threadId: number, selectedAttachmentIds?: string[]) => PromotedAttachment[];
  gate?: MailGate;
  control?: BatchControl;
}

/** Hash of the whole thread — a new/edited message in the thread changes it, triggering re-processing. */
export function threadHash(messages: { subject: string; bodyText: string }[]): string {
  const h = createHash("sha256");
  for (const m of messages) h.update(`${m.subject}\n${m.bodyText}\n`);
  return h.digest("hex");
}

/**
 * Triage one whole thread into at most one wiki note. State is keyed by
 * `thread:<id>` so a conversation is processed once, not once per message.
 */
export async function processThread(deps: RunDeps, threadId: number): Promise<"promoted" | "skipped" | "filtered" | "deferred" | "gated"> {
  const key = `thread:${threadId}`;
  const previous = deps.state.getRecord(key);
  const input = buildThreadInput(deps.store, threadId);
  if (!input) return "skipped";
  const hash = threadHash(input.messages);
  if (!deps.state.needsProcessing(key, hash)) { deps.control?.count("unchanged"); return "skipped"; }

  // Consider the thread if ANY of its messages is worth considering.
  const considerable = input.messages.some((m) =>
    shouldConsider({ fromAddr: m.fromAddr, subject: m.subject, bodyState: m.bodyState }, deps.roleOf(m.account, m.mailbox)),
  );
  if (!considerable) {
    deps.state.record({ messageId: key, decision: "filtered", categories: [], classifyModel: "prefilter", distillModel: null, wikiFilename: null, sourceHash: hash });
    return "filtered";
  }

  const attachmentInputs = deps.store.attachmentsForThread(threadId).map((row) => ({
    id: attachmentDecisionId(row),
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    messageId: row.messageId,
  }));
  // The evaluated gate predicts promoteMail only: attachments always retain
  // the complete independent triage path, even for a cached negative score.
  if (deps.gate && !attachmentInputs.length) {
    try {
      const text = buildGteInput(input, deps.userAddrs ?? [], Math.floor(Date.now()/1000));
      const stableText = text.slice(text.indexOf("\n") + 1);
      const cacheKey = createHash("sha256").update(JSON.stringify([GTE_INPUT_VERSION, deps.gate.modelId, TRIAGE_POLICY_HASH, stableText])).digest("hex");
      let decision = deps.state.gateDecision(threadId, cacheKey);
      const cached = !!decision;
      if (cached) deps.control?.count("gteCacheHits");
      else {
        if (deps.control && !deps.control.takeGate()) return "deferred";
        decision = await deps.gate.check(text, TRIAGE_POLICY_HASH);
        if (decision.reason === "scored") deps.control?.count("gteScored");
        if (["scored", "context_overflow"].includes(decision.reason)) deps.state.recordGate(threadId, cacheKey, decision);
      }
      if (!decision) throw new Error("Missing gate decision");
      deps.control?.count("gteReason/" + decision.reason);
      if (!cached) recordAudit({ actor: "scheduler", eventType: "mail.gte_decided", risk: "low", ok: true,
        summary: `GTE routed thread ${threadId} to ${decision.route}`, payload: {
          threadId, sourceHash: hash, cacheKey, modelId: deps.gate.modelId, policyHash: TRIAGE_POLICY_HASH,
          route: decision.route, reason: decision.reason, score: decision.score, threshold: decision.threshold,
          inputLength: decision.tokens, inputUnits: "gte_tokens",
          target: "promoteMail", teacherLabel: false,
        }, sourceRefs: [{ type: "mail-thread", id: threadId }] });
      if (decision.route === "discard") { deps.control?.count(cached ? "gatedCached" : "gatedNew"); return "gated"; }
    } catch {
      deps.control?.count("gteFailOpen");
    }
  } else if (deps.gate) deps.control?.count("gteBypassedAttachments");
  const retryKey = `triage-retry:${threadId}`;
  const retryHash = createHash("sha256").update(JSON.stringify([hash, TRIAGE_POLICY_HASH, attachmentInputs])).digest("hex");
  const retry = deps.state.runtime<{ hash: string; until: number; failures: number }>(retryKey);
  if (deps.control && retry?.hash === retryHash && retry.until > Date.now()) { deps.control.count("threadRetryDeferred"); return "deferred"; }
  let result;
  let deferredWithoutAttempt = false;
  const chat: Chat = async (system, user) => {
    try { return await deps.chat(system, user); }
    catch (error) { if (error instanceof DeferredChatError) deferredWithoutAttempt = true; throw error; }
  };
  try {
    result = await triage(input, chat, { userAddrs: deps.userAddrs, isThread: true, attachments: attachmentInputs });
  } catch {
    return "deferred";
  }
  if (!result) {
    if (deps.control && !deferredWithoutAttempt) {
      const failures = retry?.hash === retryHash ? retry.failures+1 : 1;
      deps.state.setRuntime(retryKey, { hash: retryHash, failures, until: Date.now()+Math.min(6*3600_000,15*60_000*2**Math.min(failures-1,5)) });
      deps.control.count("triageDeferred");
    }
    return "deferred";
  }
  if (deps.control) deps.state.setRuntime(retryKey, { hash: retryHash, failures: 0, until: 0 });
  const model = deps.model ?? "tier-5";
  // Record the actual verdict before preserving an older note or attempting
  // downstream writes. A retained canonical note is not a new positive label.
  const attachmentSnapshot = attachmentInputs
    .map((a) => [a.id, a.filename, a.mime, a.size, a.messageId])
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  recordAudit({
    actor: "scheduler", eventType: "mail.triage_decided", risk: "low", ok: true,
    summary: `Mail triage verdict for thread ${threadId}`,
    payload: {
      schemaVersion: 1, threadId, sourceHash: hash,
      attachmentInputHash: createHash("sha256").update(JSON.stringify(attachmentSnapshot)).digest("hex"),
      attachmentCount: attachmentInputs.length,
      promoteMail: result.promoteMail,
      promoteAttachments: result.attachments.some((a) => a.promote),
      promote: result.promote, model, policyHash: TRIAGE_POLICY_HASH,
      reviewBy: result.note?.reviewBy ?? null,
    },
    sourceRefs: [{ type: "mail-thread", id: threadId }],
  });
  const selectedAttachmentIds = result.attachments.filter((a) => a.promote).map((a) => a.id);
  if (!result.promote) {
    // A later message may make the current exchange non-promotable without
    // invalidating durable knowledge already captured. Keep the canonical note
    // and advance its hash so the unchanged thread is not retried forever.
    if (previous?.decision === "promoted" && previous.wikiFilename) {
      deps.state.record({
        messageId: key,
        decision: "promoted",
        categories: previous.categories,
        classifyModel: model,
        distillModel: previous.distillModel,
        wikiFilename: previous.wikiFilename,
        sourceHash: hash,
      });
      return "skipped";
    }
    deps.state.record({ messageId: key, decision: "skipped", categories: result.categories, classifyModel: model, distillModel: null, wikiFilename: null, sourceHash: hash });
    return "skipped";
  }
  const primary = input.primary;
  const attachments = selectedAttachmentIds.length ? deps.syncAttachments?.(threadId, selectedAttachmentIds) ?? [] : [];
  let wikiFilename = previous?.wikiFilename ?? null;
  let distillModel = previous?.distillModel ?? null;
  if (result.promoteMail) {
    const note = buildNote({
      msg: primary,
      accountLabel: deps.accountLabelOf(primary.account),
      distilled: result.note!,
      categories: result.categories,
      threadId,
      messageIds: input.messageIds,
      attachments,
    });
    await promote(note, deps.wiki, "current", false, previous?.wikiFilename); // bulk: skip per-note rescan, rescan once at the end
    wikiFilename = note.filename;
    distillModel = model;
  }
  const attachmentCategories = result.attachments.flatMap((a) => a.promote ? a.categories : []);
  const categories = [...new Set([...result.categories, ...attachmentCategories])];
  deps.state.record({ messageId: key, decision: "promoted", categories, classifyModel: model, distillModel, wikiFilename, sourceHash: hash });
  return "promoted";
}

export async function runBatch(
  deps: RunDeps,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<{ promoted: number; skipped: number; filtered: number; deferred: number; gated: number }> {
  const limit = opts.limit ?? 100000;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  // Distinct threads, most-recent-activity first.
  const threadIds = (deps.store.raw
    .prepare("SELECT thread_id FROM messages WHERE deleted=0 AND thread_id IS NOT NULL GROUP BY thread_id ORDER BY MAX(date) DESC LIMIT ?")
    .all(limit) as { thread_id: number }[]).map((r) => r.thread_id);
  const tally = { promoted: 0, skipped: 0, filtered: 0, deferred: 0, gated: 0 };
  // Worker pool: triage is an I/O-bound LLM+wiki call, so a handful of workers
  // pulling from a shared cursor cuts the backfill from days to hours. SQLite
  // (better-sqlite3) is synchronous, so state writes serialize naturally; the
  // cursor index and tally updates run on JS's single thread.
  let cursor = 0;
  async function worker(): Promise<void> {
    let processed = 0;
    for (;;) {
      const i = cursor++;
      if (i >= threadIds.length) return;
      try {
        tally[await processThread(deps, threadIds[i])]++;
      } catch {
        tally.deferred++; // wiki/other error — leave for retry
      }
      // Cache hits, unchanged threads and budget deferrals resolve only as
      // microtasks. Yield to pipes/timers so they cannot starve the GTE child.
      if (++processed % 16 === 0) await yieldToIO();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, threadIds.length) }, () => worker()));
  return tally;
}
