import { esc } from "@steward/applescript";
import type { MessageRef, SearchArgs, SendArgs, ReplyArgs } from "./types.ts";
import { resolveMessageRef } from "./validate.ts";

export { esc };

/**
 * AppleScript builders (pure). User text is interpolated ONLY via `esc()`.
 * Record/field separators are emitted by the script as the real US (0x1f) /
 * RS (0x1e) control chars via AppleScript `ASCII character`, so `parse.ts`
 * can split on them reliably.
 */

const SEP = ["set US to (ASCII character 31)", "set RS to (ASCII character 30)"];

/**
 * AppleScript that locates a single message across ALL mailboxes/accounts into `v`.
 *
 * Prefers Mail's native numeric `id` via `whose id is` — that property is
 * INDEXED, so the scan is fast (~5s across every mailbox). The RFC
 * `whose message id is` path is NOT indexed (~20-50s per mailbox) and is only
 * used as a fallback when no native id is available.
 */
function findMessageLines(ref: MessageRef, v = "theMsg"): string[] {
  const r = resolveMessageRef(ref);
  const predicate = r.byId ? `whose id is ${r.id}` : `whose message id is "${esc(r.messageId)}"`;
  const notFound = r.byId ? `id ${r.id}` : r.messageId;
  return [
    `  set ${v} to missing value`,
    "  repeat with acct in accounts",
    "    repeat with mb in mailboxes of acct",
    "      try",
    `        set ${v} to (first message of mb ${predicate})`,
    "        exit repeat",
    "      end try",
    "    end repeat",
    `    if ${v} is not missing value then exit repeat`,
    "  end repeat",
    `  if ${v} is missing value then error "Message not found: ${esc(notFound)}"`,
  ];
}

export function mailboxesScript(): string {
  return [
    ...SEP,
    "set savedTID to AppleScript's text item delimiters",
    'set AppleScript\'s text item delimiters to ", "',
    'set out to ""',
    'tell application "Mail"',
    "  repeat with acct in accounts",
    "    set em to \"\"",
    "    try",
    "      set em to ((email addresses of acct) as string)",
    "    end try",
    "    repeat with mb in mailboxes of acct",
    "      set out to out & (name of acct) & US & em & US & (name of mb) & RS",
    "    end repeat",
    "  end repeat",
    "end tell",
    "set AppleScript's text item delimiters to savedTID",
    "return out",
  ].join("\n");
}

/** A message row, emitted with the message's real account name in the account field. */
const RECORD_EMIT =
  'set out to out & (id of m as string) & US & (message id of m) & US & (subject of m) & US & (sender of m) & US & ((date received of m) as string) & US & (name of mailbox of m) & US & acctName & US & "" & RS';

/** Lines that safely read the message's account name into `acctName` (unified path). */
const READ_ACCT = ['set acctName to ""', "try", "  set acctName to (name of account of mailbox of m)", "end try"];

/**
 * Map a user-supplied mailbox name to one of Mail's language-neutral *unified*
 * mailbox keywords. Returns `null` for a custom folder name. Accepts common
 * English and Italian names.
 */
function unifiedMailbox(mailbox?: string): string | null {
  if (!mailbox) return "inbox"; // no mailbox filter → default to the inbox
  const m = mailbox.trim().toLowerCase();
  if (["inbox", "in", "posta in arrivo", "in arrivo"].includes(m)) return "inbox";
  if (["sent", "sent messages", "posta inviata", "inviata"].includes(m)) return "sent mailbox";
  if (["drafts", "draft", "bozze"].includes(m)) return "drafts mailbox";
  if (["junk", "spam", "posta indesiderata", "indesiderata"].includes(m)) return "junk mailbox";
  if (["trash", "deleted", "deleted messages", "cestino"].includes(m)) return "trash mailbox";
  return null;
}

/**
 * The per-account mailbox names a unified keyword corresponds to. Used to scope
 * an account-filtered search to the right folder *by name* (covering common
 * English and Italian localisations), instead of scanning every mailbox of the
 * account — which on Exchange means huge archive/All-Mail folders (~90s).
 */
const MAILBOX_NAMES: Record<string, string[]> = {
  inbox: ["Inbox", "INBOX", "Posta in arrivo"],
  "sent mailbox": ["Sent", "Sent Messages", "Sent Items", "Posta inviata"],
  "drafts mailbox": ["Drafts", "Bozze"],
  "junk mailbox": ["Junk", "Spam", "Posta indesiderata"],
  "trash mailbox": ["Trash", "Deleted Messages", "Deleted Items", "Posta eliminata", "Cestino"],
};

export function searchScript(args: SearchArgs): string {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const conds: string[] = [];
  if (args.subject) conds.push(`subject contains "${esc(args.subject)}"`);
  if (args.sender) conds.push(`sender contains "${esc(args.sender)}"`);
  if (args.unreadOnly) conds.push("read status is false");
  if (args.flaggedOnly) conds.push("flagged status is true");
  const whose = conds.length ? ` whose (${conds.join(" and ")})` : "";

  const unified = unifiedMailbox(args.mailbox);

  // Fast path — no account filter and a standard/absent mailbox. Query Mail's
  // language-neutral *unified* mailbox with a single whose. We stop after
  // `limit` messages, so reading each one's account name stays cheap.
  if (!args.account && unified) {
    return [
      ...SEP,
      'set out to ""',
      "set n to 0",
      'tell application "Mail"',
      `  set msgs to (messages of ${unified}${whose})`,
      "  repeat with m in msgs",
      `    if n ≥ ${limit} then exit repeat`,
      ...READ_ACCT.map((l) => `    ${l}`),
      `    ${RECORD_EMIT}`,
      "    set n to n + 1",
      "  end repeat",
      "end tell",
      "return out",
    ].join("\n");
  }

  // Scoped path — an account filter and/or a custom folder. Iterate matching
  // account(s) and only the target mailbox, matched by name (the standard
  // type's known localisations, or the exact custom name). This avoids the
  // unbounded unified scan (no engine-level account predicate exists:
  // `account of mailbox` cannot be used inside `whose`) and never touches an
  // account's archive folders. `account` matches the account name OR one of
  // its email addresses (a `repeat`+`is in` guard, since Mail's `whose` cannot
  // filter the list-valued `email addresses` property — errors -1719).
  const mbNames = (unified ? MAILBOX_NAMES[unified] : [args.mailbox!]);
  const mbMatch = "(" + mbNames.map((n) => `name of mb is "${esc(n)}"`).join(" or ") + ")";
  const acctMatch = args.account
    ? `(name of acct is "${esc(args.account)}" or "${esc(args.account)}" is in (email addresses of acct))`
    : "true";
  return [
    ...SEP,
    'set out to ""',
    "set n to 0",
    'tell application "Mail"',
    "  repeat with acct in accounts",
    `    if ${acctMatch} then`,
    "      set acctName to (name of acct)",
    "      repeat with mb in mailboxes of acct",
    `        if ${mbMatch} then`,
    `          if n < ${limit} then`,
    "            try",
    `              set msgs to (messages of mb${whose})`,
    "              repeat with m in msgs",
    `                if n ≥ ${limit} then exit repeat`,
    `                ${RECORD_EMIT}`,
    "                set n to n + 1",
    "              end repeat",
    "            end try",
    "          end if",
    "        end if",
    "      end repeat",
    "    end if",
    "  end repeat",
    "end tell",
    "return out",
  ].join("\n");
}

export function readScript(ref: MessageRef): string {
  return [
    ...SEP,
    'tell application "Mail"',
    ...findMessageLines(ref),
    // Reading `content` of an Exchange/IMAP message can block while Mail
    // downloads the body from the server on first access. `with timeout`
    // raises Mail's per-AppleEvent limit (default 60s → -1712) so the long
    // osascript timeout governs instead. The try still guards a genuine
    // content error so we always return the metadata.
    '  set theBody to ""',
    "  with timeout of 600 seconds",
    "    try",
    "      set theBody to (content of theMsg)",
    "    on error errMsg",
    '      set theBody to ("[body unavailable: " & errMsg & "]")',
    "    end try",
    "  end timeout",
    "  set out to (subject of theMsg) & US & (sender of theMsg) & US & ((date received of theMsg) as string) & US & theBody",
    "end tell",
    "return out",
  ].join("\n");
}

export function saveAttachmentScript(ref: MessageRef, attachment: string | number, destPath: string): string {
  const sel = typeof attachment === "number"
    ? `mail attachment ${attachment} of theMsg`
    : `(first mail attachment of theMsg whose name is "${esc(attachment)}")`;
  return [
    'tell application "Mail"',
    ...findMessageLines(ref),
    `  save ${sel} in POSIX file "${esc(destPath)}"`,
    "end tell",
    `return "${esc(destPath)}"`,
  ].join("\n");
}

export function sendScript(args: SendArgs): string {
  // `sender` must match one of the configured accounts' addresses; when omitted
  // Mail sends from its default account.
  const props = [`subject:"${esc(args.subject)}"`, `content:"${esc(args.body)}"`];
  if (args.from) props.push(`sender:"${esc(args.from)}"`);
  props.push("visible:false");
  const lines: string[] = [
    'tell application "Mail"',
    `  set msg to make new outgoing message with properties {${props.join(", ")}}`,
    "  tell msg",
  ];
  for (const to of args.to) {
    lines.push(`    make new to recipient at end of to recipients with properties {address:"${esc(to)}"}`);
  }
  for (const cc of args.cc ?? []) {
    lines.push(`    make new cc recipient at end of cc recipients with properties {address:"${esc(cc)}"}`);
  }
  for (const bcc of args.bcc ?? []) {
    lines.push(`    make new bcc recipient at end of bcc recipients with properties {address:"${esc(bcc)}"}`);
  }
  for (const att of args.attachments ?? []) {
    lines.push(`    make new attachment with properties {file name:(POSIX file "${esc(att)}")} at after the last paragraph`);
  }
  lines.push("    send");
  lines.push("  end tell");
  lines.push("end tell");
  lines.push('return "sent"');
  return lines.join("\n");
}

export function replyScript(args: ReplyArgs): string {
  const body = esc(args.body);
  const lines: string[] = [
    'tell application "Mail"',
    "  with timeout of 600 seconds",
    ...findMessageLines(args, "orig"),
    // Mail.app can send blank-body replies if we set content and immediately
    // send. Saving and verifying the draft before sending prevents that on
    // Exchange/Mail.app. We preserve Mail's generated quoted reply content
    // when available, but only verify the new reply body: Mail may rewrite
    // quote/signature formatting during save/send.
    `  set r to reply orig opening window false${args.replyAll ? " reply to all true" : ""}`,
    `  set replyBody to "${body}"`,
    '  set quotedContent to ""',
    "  delay 1",
    "  try",
    "    set quotedContent to ((content of r) as string)",
    "  end try",
    "  if quotedContent is \"\" then",
    "    set finalBody to replyBody",
    "  else",
    "    set finalBody to replyBody & return & return & quotedContent",
    "  end if",
    "  tell r",
    ...(args.from ? [`    set sender to "${esc(args.from)}"`] : []),
    "    set content to finalBody",
    "  end tell",
    "  save r",
    "  delay 1",
    "  set observedBody to ((content of r) as string)",
    '  if observedBody does not contain replyBody then error "Reply body was not persisted before send"',
    "  tell r",
  ];
  for (const att of args.attachments ?? []) {
    lines.push(`    make new attachment with properties {file name:(POSIX file "${esc(att)}")} at after the last paragraph`);
  }
  lines.push("    send");
  lines.push("  end tell");
  lines.push("  end timeout");
  lines.push("end tell");
  lines.push('return "sent"');
  return lines.join("\n");
}
