#!/usr/bin/env -S node --import tsx
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../../../apps/mail-mirror/src/store.ts";
import { dbPath as mailDbPath } from "../../../apps/mail-mirror/src/paths.ts";
import { sendScript, replyScript } from "../../../apps/mail-mcp/src/applescript.ts";
import { runOsa } from "../../../apps/mail-mcp/src/osascript.ts";
import type { ReplyArgs, SendArgs } from "../../../apps/mail-mcp/src/types.ts";
import { IndexDb } from "../../../apps/calendar-mcp/src/index-db.ts";
import { indexDbPath as calendarIndexDbPath } from "../../../apps/calendar-mcp/src/paths.ts";
import { WriteOpsStore, type WriteOpRow } from "./index.ts";

const execFileAsync = promisify(execFile);

const RETRY_AFTER_CONFIRM_ATTEMPTS = Math.max(
  1,
  Number(process.env.WRITE_OP_RETRY_AFTER_CONFIRM_ATTEMPTS ?? 3),
);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.WRITE_OP_MAX_ATTEMPTS ?? 2));

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "reconcile-mail") {
    const res = await reconcileMailWrites();
    console.log(`write-ops mail: confirmed ${res.confirmed}, pending ${res.pending}, retried ${res.retried}, exhausted ${res.exhausted}`);
    return;
  }
  if (cmd === "reconcile-calendar") {
    const res = await reconcileCalendarWrites();
    console.log(`write-ops calendar: confirmed ${res.confirmed}, pending ${res.pending}`);
    return;
  }
  if (cmd === "send-due") {
    const res = await sendDueWrites();
    console.log(`write-ops send-due: fired ${res.fired}, failed ${res.failed}`);
    return;
  }
  if (cmd === "status") {
    const store = WriteOpsStore.open();
    const rows = store.raw.prepare("SELECT status, count(*) c FROM write_ops GROUP BY status ORDER BY status").all();
    console.log(JSON.stringify(rows, null, 2));
    store.close();
    return;
  }
  console.log("usage: write-ops <reconcile-mail|reconcile-calendar|send-due|status>");
  process.exit(1);
}

/** Fire scheduled sends/replies whose time has come, then let reconcile confirm them. */
export async function sendDueWrites(): Promise<{ fired: number; failed: number }> {
  const ops = WriteOpsStore.open();
  const now = Math.floor(Date.now() / 1000);
  let fired = 0;
  let failed = 0;
  try {
    for (const op of ops.dueScheduled(now, 50)) {
      try {
        if (op.kind === "mail.send") {
          await runOsa(sendScript(op.input as unknown as SendArgs), { timeoutMs: 300_000 });
        } else if (op.kind === "mail.reply") {
          await runOsa(replyScript(op.input as unknown as ReplyArgs), { timeoutMs: 300_000 });
        } else {
          ops.failed(op.id, new Error(`unsupported scheduled kind: ${op.kind}`));
          failed++;
          continue;
        }
        // Hand off to the normal confirmation flow (reconcile-mail verifies it landed).
        ops.scriptReturned(op.id, { scheduled: true });
        fired++;
      } catch (err) {
        ops.failed(op.id, err);
        failed++;
      }
    }
  } finally {
    ops.close();
  }
  return { fired, failed };
}

export async function reconcileCalendarWrites(): Promise<{ confirmed: number; pending: number }> {
  const ops = WriteOpsStore.open();
  const index = IndexDb.open(calendarIndexDbPath());
  let confirmed = 0;
  let pending = 0;
  try {
    for (const op of ops.pendingForConfirmation(["calendar.create", "calendar.update", "calendar.delete"], 100)) {
      const ok = findCalendarConfirmation(index, op);
      if (ok) {
        ops.markConfirmed(op.id, { uid: op.result?.uid ?? op.input.uid ?? op.expected.uid });
        confirmed++;
      } else {
        ops.incrementConfirmAttempt(op.id);
        pending++;
      }
    }
  } finally {
    index.close();
    ops.close();
  }
  return { confirmed, pending };
}

function findCalendarConfirmation(index: IndexDb, op: WriteOpRow): boolean {
  const uid = typeof op.result?.uid === "string"
    ? op.result.uid
    : typeof op.input.uid === "string"
      ? op.input.uid
      : typeof op.expected.uid === "string"
        ? op.expected.uid
        : "";
  if (op.kind === "calendar.delete") return uid ? index.getEvent(uid) === null : false;
  if (op.kind === "calendar.update") {
    if (!uid) return false;
    const ev = index.getEvent(uid);
    if (!ev) return false;
    return calendarFieldsMatch(ev as unknown as Record<string, unknown>, op.expected);
  }
  if (op.kind === "calendar.create") {
    if (uid) {
      const ev = index.getEvent(uid);
      return !!ev && calendarFieldsMatch(ev as unknown as Record<string, unknown>, op.expected);
    }
    return false;
  }
  return false;
}

function calendarFieldsMatch(ev: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const key of ["calendar", "summary", "start", "end", "location", "description", "url"] as const) {
    if (expected[key] == null) continue;
    if (String(ev[key] ?? "") !== String(expected[key])) return false;
  }
  return true;
}

export async function reconcileMailWrites(): Promise<{ confirmed: number; pending: number; retried: number; exhausted: number }> {
  const ops = WriteOpsStore.open();
  const mail = Store.openReadonly(mailDbPath());
  let confirmed = 0;
  let pending = 0;
  let retried = 0;
  let exhausted = 0;
  try {
    for (const op of ops.pendingForConfirmation(["mail.send", "mail.reply"], 100)) {
      const match = findMailConfirmation(mail, op);
      if (match) {
        ops.markConfirmed(op.id, { messageId: match.message_id, date: match.date, mailbox: match.mailbox });
        confirmed++;
        continue;
      }
      ops.incrementConfirmAttempt(op.id);
      const afterThisAttempt = op.confirmAttempts + 1;
      if (shouldPrepareRetry(op, afterThisAttempt)) {
        try {
          await restartMailForWrite();
          ops.markRestartPrepared(op.id);
          pending++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ops.markRetryExhausted(op.id, message);
          exhausted++;
        }
      } else if (shouldRetry(op)) {
        ops.markRetrying(op.id);
        try {
          await retryMailOperation(op);
          ops.scriptReturned(op.id, { retried: true });
          retried++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ops.markRetryExhausted(op.id, message);
          exhausted++;
        }
      } else {
        pending++;
      }
    }
  } finally {
    mail.close();
    ops.close();
  }
  return { confirmed, pending, retried, exhausted };
}

function shouldPrepareRetry(op: WriteOpRow, confirmAttempts: number): boolean {
  if (!["unknown", "failed"].includes(op.status)) return false;
  if (op.attempts >= MAX_ATTEMPTS) return false;
  return confirmAttempts >= RETRY_AFTER_CONFIRM_ATTEMPTS;
}

function shouldRetry(op: WriteOpRow): boolean {
  if (op.status !== "restart_prepared") return false;
  return op.attempts < MAX_ATTEMPTS;
}

export function findMailConfirmation(mail: Store, op: WriteOpRow): { message_id: string; date: number; mailbox: string } | null {
  const snippet = typeof op.expected.bodySnippet === "string" ? op.expected.bodySnippet : "";
  if (!snippet) return null;
  const from = typeof op.expected.from === "string" ? op.expected.from.trim().toLowerCase() : "";
  const subject = typeof op.expected.subject === "string" ? op.expected.subject.trim() : "";
  const startedAt = op.startedAt - 300;
  const clauses = [
    "deleted=0",
    "date>=?",
    "body_text LIKE ? ESCAPE '\\'",
  ];
  const params: unknown[] = [startedAt, `%${snippet.replace(/[\\%_]/g, "\\$&")}%`];
  if (from) {
    clauses.push("lower(from_addr)=?");
    params.push(from);
  }
  if (subject) {
    clauses.push("subject=?");
    params.push(subject);
  }
  const row = mail.raw.prepare(
    `SELECT message_id, date, mailbox FROM messages
     WHERE ${clauses.join(" AND ")}
     ORDER BY date DESC
     LIMIT 1`,
  ).get(...params) as { message_id: string; date: number; mailbox: string } | undefined;
  return row ?? null;
}

async function retryMailOperation(op: WriteOpRow): Promise<void> {
  if (op.kind === "mail.send") {
    await runOsa(sendScript(op.input as unknown as SendArgs), { timeoutMs: 300_000 });
    return;
  }
  if (op.kind === "mail.reply") {
    await runOsa(replyScript(op.input as unknown as ReplyArgs), { timeoutMs: 300_000 });
    return;
  }
  throw new Error(`unsupported mail retry kind: ${op.kind}`);
}

async function restartMailForWrite(): Promise<void> {
  const hasVisibleCompose = await mailHasVisibleComposeWindow().catch(() => false);
  if (hasVisibleCompose) {
    throw new Error("Mail has visible compose windows; refusing automatic restart");
  }
  await quitMail().catch(async () => {
    await execFileAsync("/usr/bin/killall", ["Mail"]).catch(() => undefined);
  });
  await sleep(2000);
  await runOsa('tell application "Mail" to activate', { timeoutMs: 30_000 });
  await waitForMailHealthy();
}

async function mailHasVisibleComposeWindow(): Promise<boolean> {
  const out = await runOsa(`
tell application "Mail"
  set n to 0
  repeat with m in outgoing messages
    try
      if visible of m is true then set n to n + 1
    end try
  end repeat
  return n as string
end tell`, { timeoutMs: 10_000 });
  return Number(out.trim()) > 0;
}

async function quitMail(): Promise<void> {
  await runOsa('tell application "Mail" to quit', { timeoutMs: 20_000 });
}

async function waitForMailHealthy(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await runOsa('tell application "Mail" to return (count of accounts) as string', { timeoutMs: 10_000 });
      return;
    } catch (err) {
      lastErr = err;
      await sleep(2000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "Mail did not become healthy"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
