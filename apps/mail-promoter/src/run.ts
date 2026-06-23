import { createHash } from "node:crypto";
import type { Store } from "../../mail-mirror/src/store.ts";
import type { PromoteState } from "./state.ts";
import type { Chat } from "./llm.ts";
import type { WikiPromoter } from "./wiki.ts";
import { shouldConsider } from "./prefilter.ts";
import { triage } from "./triage.ts";
import { buildThreadInput } from "./thread-input.ts";
import { buildNote } from "./note.ts";
import { promote } from "./wiki.ts";

export interface RunDeps {
  store: Store;
  state: PromoteState;
  chat: Chat;
  wiki: WikiPromoter;
  roleOf: (account: string, mailbox: string) => string | undefined;
  accountLabelOf: (account: string) => string;
  userAddrs?: string[];
  model?: string;
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
export async function processThread(deps: RunDeps, threadId: number): Promise<"promoted" | "skipped" | "filtered" | "deferred"> {
  const key = `thread:${threadId}`;
  const input = buildThreadInput(deps.store, threadId);
  if (!input) return "skipped";
  const hash = threadHash(input.messages);
  if (!deps.state.needsProcessing(key, hash)) return "skipped";

  // Consider the thread if ANY of its messages is worth considering.
  const considerable = input.messages.some((m) =>
    shouldConsider({ fromAddr: m.fromAddr, subject: m.subject, bodyState: m.bodyState }, deps.roleOf(m.account, m.mailbox)),
  );
  if (!considerable) {
    deps.state.record({ messageId: key, decision: "filtered", categories: [], classifyModel: "prefilter", distillModel: null, wikiFilename: null, sourceHash: hash });
    return "filtered";
  }

  let result;
  try {
    result = await triage(input, deps.chat, { userAddrs: deps.userAddrs, isThread: true });
  } catch {
    return "deferred";
  }
  if (!result) return "deferred"; // LLM unavailable / unparseable / promote w/o note — retry next run, no state
  const model = deps.model ?? "tier-5";
  if (!result.promote) {
    deps.state.record({ messageId: key, decision: "skipped", categories: result.categories, classifyModel: model, distillModel: null, wikiFilename: null, sourceHash: hash });
    return "skipped";
  }
  const primary = input.primary;
  const note = buildNote({
    msg: primary,
    accountLabel: deps.accountLabelOf(primary.account),
    distilled: result.note!,
    categories: result.categories,
    threadId,
    messageIds: input.messageIds,
  });
  await promote(note, deps.wiki, "current", false); // bulk: skip per-note rescan, rescan once at the end
  deps.state.record({ messageId: key, decision: "promoted", categories: result.categories, classifyModel: model, distillModel: model, wikiFilename: note.filename, sourceHash: hash });
  return "promoted";
}

export async function runBatch(
  deps: RunDeps,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<{ promoted: number; skipped: number; filtered: number; deferred: number }> {
  const limit = opts.limit ?? 100000;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  // Distinct threads, most-recent-activity first.
  const threadIds = (deps.store.raw
    .prepare("SELECT thread_id FROM messages WHERE deleted=0 AND thread_id IS NOT NULL GROUP BY thread_id ORDER BY MAX(date) DESC LIMIT ?")
    .all(limit) as { thread_id: number }[]).map((r) => r.thread_id);
  const tally = { promoted: 0, skipped: 0, filtered: 0, deferred: 0 };
  // Worker pool: triage is an I/O-bound LLM+wiki call, so a handful of workers
  // pulling from a shared cursor cuts the backfill from days to hours. SQLite
  // (better-sqlite3) is synchronous, so state writes serialize naturally; the
  // cursor index and tally updates run on JS's single thread.
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= threadIds.length) return;
      try {
        tally[await processThread(deps, threadIds[i])]++;
      } catch {
        tally.deferred++; // wiki/other error — leave for retry
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, threadIds.length) }, () => worker()));
  return tally;
}
