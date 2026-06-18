import type { SearchArgs, SendArgs, ReplyArgs } from "./types.ts";

/**
 * AppleScript builders (pure). User text is interpolated ONLY via `esc()`.
 * Record/field separators are emitted by the script as the real US (0x1f) /
 * RS (0x1e) control chars via AppleScript `ASCII character`, so `parse.ts`
 * can split on them reliably. Scripts that return data prepend:
 *   set US to (ASCII character 31)
 *   set RS to (ASCII character 30)
 */

/** Escape a string for inclusion inside an AppleScript double-quoted literal. */
export function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const SEP = ['set US to (ASCII character 31)', "set RS to (ASCII character 30)"];

export function mailboxesScript(): string {
  return [
    ...SEP,
    'set out to ""',
    'tell application "Mail"',
    "  repeat with acct in accounts",
    "    repeat with mb in mailboxes of acct",
    "      set out to out & (name of acct) & US & (name of mb) & RS",
    "    end repeat",
    "  end repeat",
    "end tell",
    "return out",
  ].join("\n");
}

export function searchScript(args: SearchArgs): string {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const conds: string[] = [];
  if (args.subject) conds.push(`subject contains "${esc(args.subject)}"`);
  if (args.sender) conds.push(`sender contains "${esc(args.sender)}"`);
  if (args.unreadOnly) conds.push("read status is false");
  if (args.flaggedOnly) conds.push("flagged status is true");
  const whose = conds.length ? ` whose (${conds.join(" and ")})` : "";
  const mailboxExpr = args.mailbox
    ? `(first mailbox whose name is "${esc(args.mailbox)}")`
    : "inbox";
  return [
    ...SEP,
    'set out to ""',
    "set n to 0",
    'tell application "Mail"',
    `  set msgs to (messages of ${mailboxExpr}${whose})`,
    "  repeat with m in msgs",
    `    if n ≥ ${limit} then exit repeat`,
    "    set out to out & (message id of m) & US & (subject of m) & US & (sender of m) & US & ((date received of m) as string) & US & (name of mailbox of m) & US & \"\" & US & \"\" & RS",
    "    set n to n + 1",
    "  end repeat",
    "end tell",
    "return out",
  ].join("\n");
}

export function readScript(messageId: string): string {
  return [
    ...SEP,
    'tell application "Mail"',
    `  set m to (first message of inbox whose message id is "${esc(messageId)}")`,
    "  set out to (subject of m) & US & (sender of m) & US & ((date received of m) as string) & US & (content of m)",
    "end tell",
    "return out",
  ].join("\n");
}

export function saveAttachmentScript(messageId: string, attachment: string | number, destPath: string): string {
  const sel = typeof attachment === "number"
    ? `mail attachment ${attachment} of m`
    : `(first mail attachment of m whose name is "${esc(attachment)}")`;
  return [
    'tell application "Mail"',
    `  set m to (first message of inbox whose message id is "${esc(messageId)}")`,
    `  save ${sel} in POSIX file "${esc(destPath)}"`,
    "end tell",
    `return "${esc(destPath)}"`,
  ].join("\n");
}

export function sendScript(args: SendArgs): string {
  const lines: string[] = [
    'tell application "Mail"',
    `  set msg to make new outgoing message with properties {subject:"${esc(args.subject)}", content:"${esc(args.body)}", visible:false}`,
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
  const lines: string[] = [
    'tell application "Mail"',
    `  set orig to (first message of inbox whose message id is "${esc(args.messageId)}")`,
    `  set r to reply orig opening window false${args.replyAll ? " reply to all true" : ""}`,
    `  set content of r to "${esc(args.body)}" & return & content of r`,
  ];
  for (const att of args.attachments ?? []) {
    lines.push(`  tell r to make new attachment with properties {file name:(POSIX file "${esc(att)}")} at after the last paragraph`);
  }
  lines.push("  send r");
  lines.push("end tell");
  lines.push('return "sent"');
  return lines.join("\n");
}
