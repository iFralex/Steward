import { createHash } from "node:crypto";
import type { Store, MessageRow } from "../../mail-mirror/src/store.ts";
import type { PromoteState } from "./state.ts";
import type { Chat } from "./llm.ts";
import type { WikiPromoter } from "./wiki.ts";
import { shouldConsider } from "./prefilter.ts";
import { triage } from "./triage.ts";
import { buildNote } from "./note.ts";
import { promote } from "./wiki.ts";

export interface RunDeps {
  store: Store;
  state: PromoteState;
  chat: Chat;
  wiki: WikiPromoter;
  roleOf: (account: string, mailbox: string) => string | undefined;
  accountLabelOf: (account: string) => string;
  model?: string;
}

export function sourceHash(msg: { subject: string; bodyText: string }): string {
  return createHash("sha256").update(`${msg.subject}\n${msg.bodyText}`).digest("hex");
}

export async function processOne(deps: RunDeps, msg: MessageRow): Promise<"promoted" | "skipped" | "filtered" | "deferred"> {
  const hash = sourceHash(msg);
  if (!deps.state.needsProcessing(msg.messageId, hash)) return "skipped";
  if (!shouldConsider({ fromAddr: msg.fromAddr, subject: msg.subject, bodyState: msg.bodyState }, deps.roleOf(msg.account, msg.mailbox))) {
    deps.state.record({ messageId: msg.messageId, decision: "filtered", categories: [], classifyModel: "prefilter", distillModel: null, wikiFilename: null, sourceHash: hash });
    return "filtered";
  }
  let result;
  try {
    result = await triage(msg, deps.chat);
  } catch {
    return "deferred";
  }
  if (!result) return "deferred"; // LLM unavailable / unparseable / promote w/o note — retry next run, no state
  const model = deps.model ?? "tier-5";
  if (!result.promote) {
    deps.state.record({ messageId: msg.messageId, decision: "skipped", categories: result.categories, classifyModel: model, distillModel: null, wikiFilename: null, sourceHash: hash });
    return "skipped";
  }
  const note = buildNote({ msg, accountLabel: deps.accountLabelOf(msg.account), distilled: result.note!, categories: result.categories });
  await promote(note, deps.wiki);
  deps.state.record({ messageId: msg.messageId, decision: "promoted", categories: result.categories, classifyModel: model, distillModel: model, wikiFilename: note.filename, sourceHash: hash });
  return "promoted";
}

export async function runBatch(deps: RunDeps, opts: { limit?: number } = {}): Promise<{ promoted: number; skipped: number; filtered: number; deferred: number }> {
  const limit = opts.limit ?? 100000;
  const ids = (deps.store.raw.prepare("SELECT message_id FROM messages WHERE deleted=0 ORDER BY date DESC LIMIT ?").all(limit) as { message_id: string }[]).map((r) => r.message_id);
  const tally = { promoted: 0, skipped: 0, filtered: 0, deferred: 0 };
  for (const id of ids) {
    const msg = deps.store.getMessage(id);
    if (!msg) continue;
    try {
      tally[await processOne(deps, msg)]++;
    } catch {
      tally.deferred++; // wiki/other error — leave for retry
    }
  }
  return tally;
}
