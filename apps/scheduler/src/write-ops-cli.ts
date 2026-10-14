#!/usr/bin/env -S node --import tsx
import { parseEventKitRecurrence } from "../../calendar-mcp/src/rrule.ts";
import { fileURLToPath } from "node:url";
import { Store } from "../../mail-mirror/src/store.ts";
import { dbPath as mailDbPath } from "../../mail-mirror/src/paths.ts";
import { sendScript, replyScript } from "../../mail-mcp/src/applescript.ts";
import { runOsa } from "../../mail-mcp/src/osascript.ts";
import type { ReplyArgs, SendArgs } from "../../mail-mcp/src/types.ts";
import { eventKitBridgeAvailable, readEventKit } from "../../calendar-mcp/src/eventkit-client.ts";
import type { CalEvent } from "../../calendar-mcp/src/types.ts";
import { IndexDb } from "../../calendar-mcp/src/index-db.ts";
import { indexDbPath as calendarIndexDbPath } from "../../calendar-mcp/src/paths.ts";
import { WriteOpsStore, type WriteOpRow } from "@steward/write-ops";

const MAX_MAIL_CONFIRM_ATTEMPTS = Math.max(
  1,
  Number(process.env.WRITE_OP_MAIL_MAX_CONFIRM_ATTEMPTS ?? 12),
);
const MAX_CALENDAR_CONFIRM_ATTEMPTS = Math.max(
  1,
  Number(process.env.WRITE_OP_CALENDAR_MAX_CONFIRM_ATTEMPTS ?? 12),
);

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
    const store = WriteOpsStore.open(undefined, "scheduler");
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
  const ops = WriteOpsStore.open(undefined, "scheduler");
  const now = Math.floor(Date.now() / 1000);
  let fired = 0;
  let failed = 0;
  try {
    for (const candidate of ops.dueScheduled(now, 50)) {
      const op = ops.claimScheduled(candidate.id, now);
      if (!op) continue;
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
  const ops = WriteOpsStore.open(undefined, "scheduler");
  const index = IndexDb.open(calendarIndexDbPath());
  let confirmed = 0;
  let pending = 0;
  try {
    for (const op of ops.pendingForConfirmation(["calendar.create", "calendar.update", "calendar.delete"], 100)) {
      let native: CalEvent | null | undefined;
      const recordedUid = op.result?.uid ?? op.input.uid;
      if (eventKitBridgeAvailable() && typeof recordedUid === 'string') {
        try { native = await readEventKit(index.resolveUid(recordedUid) ?? recordedUid, op.input.occurrenceStart as string | undefined); }
        catch {
          if (shouldExhaustCalendarConfirmation(op)) ops.markNeedsReview(op.id, 'Native Calendar verification unavailable; inspect the event before repeating the write.');
          else { ops.incrementConfirmAttempt(op.id); pending++; }
          continue;
        }
      }
      const confirmedUid = findCalendarConfirmation(index, op, native);
      if (confirmedUid) {
        ops.markConfirmed(op.id, { uid: confirmedUid });
        confirmed++;
      } else if (shouldExhaustCalendarConfirmation(op)) {
        const detail = op.lastError ? ` Last error: ${op.lastError}` : "";
        ops.markRetryExhausted(op.id, `Calendar write could not be confirmed.${detail}`);
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

export function shouldExhaustCalendarConfirmation(op: WriteOpRow): boolean {
  const uid = typeof op.result?.uid === "string" && op.result.uid
    ? op.result.uid
    : typeof op.input.uid === "string" && op.input.uid
      ? op.input.uid
      : "";
  if (op.status === "failed" && op.kind === "calendar.create" && !uid) return true;
  return op.confirmAttempts + 1 >= MAX_CALENDAR_CONFIRM_ATTEMPTS;
}

export function findCalendarConfirmation(index: IndexDb, op: WriteOpRow, native?: CalEvent | null): string | null {
  const uid = typeof op.result?.uid === "string"
    ? op.result.uid
    : typeof op.input.uid === "string"
      ? op.input.uid
      : typeof op.expected.uid === "string"
        ? op.expected.uid
        : "";
  if (uid && native !== undefined) {
    if (op.kind === 'calendar.delete') return native === null && op.expected.targetExisted === true ? uid : null;
    return native && calendarFieldsMatch(native as unknown as Record<string, unknown>, op.expected) ? native.uid : null;
  }
  // A future-series effect or exact recurrence edit requires native evidence.
  if (op.expected.scope === 'futureEvents' || op.expected.recurrence != null) return null;
  const resolvedUid = uid ? index.resolveUid(uid) ?? uid : '';
  const fresh = Number(index.getState('completed_sync_started_at') ?? 0) > (op.scriptFinishedAtMs ?? ((op.scriptFinishedAt ?? op.startedAt) + 1) * 1000);
  if (typeof op.startedAt === "number" && !fresh) return null;
  if (op.kind === "calendar.delete") return op.expected.targetExisted === true && fresh && uid && index.getEvent(resolvedUid) === null ? uid : null;
  if (op.kind === "calendar.update") {
    if (!uid) return null;
    const ev = index.getEvent(resolvedUid);
    if (!ev) return null;
    return calendarFieldsMatch(ev as unknown as Record<string, unknown>, op.expected) ? ev.uid : null;
  }
  if (op.kind === "calendar.create") {
    if (uid) {
      const ev = index.getEvent(resolvedUid);
      return ev && calendarFieldsMatch(ev as unknown as Record<string, unknown>, op.expected) ? ev.uid : null;
    }
    const candidates = index.writeConfirmationCandidates(op.expected)
      .filter((event) => calendarFieldsMatch(event as unknown as Record<string, unknown>, op.expected));
    return candidates.length === 1 ? candidates[0].uid : null;
  }
  return null;
}

export function calendarFieldsMatch(ev: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const key of ["calendar", "summary", "location", "description", "url"] as const) {
    if (expected[key] == null) continue;
    if (String(ev[key] ?? "") !== String(expected[key])) return false;
  }
  // Calendar's private database stores all-day boundaries independently from
  // EventKit's local-midnight representation. Across a DST transition those
  // instants can differ by an hour (and EventKit may expose the inclusive end
  // as one second before midnight), while still describing the same civil
  // dates. Reconcile all-day writes by local calendar date, not epoch value.
  const compareAsCivilDate = Boolean(ev.allDay) || expected.allDay === true;
  for (const key of ["start", "end"] as const) {
    if (expected[key] == null) continue;
    if (compareAsCivilDate) {
      if (localCivilDate(ev[key]) !== localCivilDate(expected[key])) return false;
    } else if (String(ev[key] ?? "") !== String(expected[key])) {
      return false;
    }
  }
  if (expected.calendarId != null && String(ev.calendarId ?? "") !== String(expected.calendarId)) return false;
  if (expected.allDay != null && Boolean(ev.allDay) !== Boolean(expected.allDay)) return false;
  if (expected.alarms != null) {
    if (!Array.isArray(expected.alarms) || !Array.isArray(ev.alarms)) return false;
    const normalized = (value: unknown[]) => value.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (JSON.stringify(normalized(ev.alarms)) !== JSON.stringify(normalized(expected.alarms))) return false;
  }
  if (expected.recurrence != null) {
    const expectedPresence = typeof expected.recurrence === "string" && expected.recurrence.trim().length > 0;
    if (Boolean(ev.hasRecurrence) !== expectedPresence) return false;
    // Presence alone cannot confirm an RRULE change.
    if (expectedPresence && (!canonicalRule(expected.recurrence) || canonicalRule(ev.recurrence) !== canonicalRule(expected.recurrence))) return false;
    if (expectedPresence && ev.recurrenceRuleCount != null && ev.recurrenceRuleCount !== 1) return false;
  }
  return true;
}

function canonicalRule(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const spec = parseEventKitRecurrence(value);
    if (spec.until?.length === 8) spec.until += 'T235959Z';
    if (spec.daysOfWeek) spec.daysOfWeek.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    for (const key of ['daysOfMonth','monthsOfYear','weeksOfYear','daysOfYear','setPositions'] as const) spec[key]?.sort((a,b) => a-b);
    return JSON.stringify(spec);
  } catch { return null; }
}

function localCivilDate(value: unknown): string | null {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export async function reconcileMailWrites(): Promise<{ confirmed: number; pending: number; retried: number; exhausted: number }> {
  const ops = WriteOpsStore.open(undefined, "scheduler");
  const mail = Store.openReadonly(mailDbPath());
  let confirmed = 0;
  let pending = 0;
  const retried = 0;
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
      if (shouldExhaustMailConfirmation(afterThisAttempt)) {
        ops.markNeedsReview(op.id, "Mail delivery could not be confirmed. Inspect Sent mail; a new send requires explicit user approval.");
        exhausted++;
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

export function shouldExhaustMailConfirmation(confirmAttempts: number): boolean {
  return confirmAttempts >= MAX_MAIL_CONFIRM_ATTEMPTS;
}

export function findMailConfirmation(mail: Store, op: WriteOpRow): { message_id: string; date: number; mailbox: string } | null {
  const addresses = (value: unknown): string[] => {
    if (Array.isArray(value)) return [...new Set(value.map(String).map(v => v.trim().toLowerCase()))].sort();
    if (typeof value !== "string") return [];
    try { return addresses(JSON.parse(value)); } catch { return addresses(value.split(/[,;\s]+/).filter(Boolean)); }
  };
  const sourceId = String(op.expected.messageId ?? op.input.messageId ?? op.input.id ?? "");
  const source = op.kind === "mail.reply" ? mail.getMessage(sourceId) : undefined;
  const expectedTo = addresses(op.expected.to ?? op.input.to ?? (source ? [source.fromAddr] : undefined));
  const expectedCc = addresses(op.expected.cc ?? op.input.cc ?? []);
  // replyAll requires resolved recipient evidence; never infer an incomplete set.
  if (addresses(op.input.bcc).length) return null; // mirror has no BCC evidence
  if (!expectedTo.length || (op.kind === "mail.reply" && op.input.replyAll === true && !op.expected.to)) return null;
  const from = String(op.expected.from ?? op.input.from ?? "").trim().toLowerCase();
  const account = String(op.expected.account ?? source?.account ?? "");
  const attemptedAt = op.attemptedAt ?? op.startedAt;
  const body = String(op.input.body ?? "").replace(/\s+/g, " ").trim();
  if (!body) return null;
  const rows = mail.raw.prepare(`SELECT m.*, a.emails AS own_emails FROM messages m
    JOIN mailbox_roles r ON r.account_uuid=m.account AND r.mailbox_name=m.mailbox AND r.role='sent'
    JOIN accounts a ON a.uuid=m.account
    WHERE m.deleted=0 AND m.date>=? AND m.date<=? ORDER BY m.date LIMIT 200`)
    .all(attemptedAt - 60, attemptedAt + 86400) as Record<string, unknown>[];
  if (rows.length === 200) return null; // An incomplete candidate set cannot prove uniqueness.
  const matches = rows.filter(row => {
    const sender = String(row.from_addr ?? "").trim().toLowerCase();
    if (!addresses(row.own_emails).includes(sender) || (from && sender !== from) || (account && row.account !== account)) return false;
    if (JSON.stringify(addresses(row.to_addrs)) !== JSON.stringify(expectedTo)
      || JSON.stringify(addresses(row.cc_addrs)) !== JSON.stringify(expectedCc)) return false;
    if (op.kind === "mail.reply") {
      if (!source || row.in_reply_to !== source.messageId) return false;
    } else if (String(row.subject ?? "") !== String(op.expected.subject ?? op.input.subject ?? "")) return false;
    // Match the complete normalized outgoing text, not merely a 120-char prefix.
    return String(row.body_text ?? "").replace(/\s+/g, " ").trim() === body;
  });
  return matches.length === 1 ? matches[0] as unknown as { message_id: string; date: number; mailbox: string } : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
