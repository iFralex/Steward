import type { Store } from "../../mail-mirror/src/store.ts";

export const ROLE_KEYWORDS = ["inbox", "drafts", "sent", "trash", "junk", "archive", "important", "flagged"] as const;
type RoleKeyword = (typeof ROLE_KEYWORDS)[number];

function isRole(s: string): s is RoleKeyword {
  return (ROLE_KEYWORDS as readonly string[]).includes(s.toLowerCase());
}

/** Resolve a friendly account (email/name → UUID) and a mailbox (role keyword → mailbox names, else literal). */
export function resolveScope(
  store: Store,
  args: { account?: string; mailbox?: string; anyMailbox?: boolean },
): { account?: string; mailboxNames?: string[]; anyMailbox?: boolean } {
  let account = args.account;
  if (account) account = store.accountByEmailOrName(account) ?? account;

  let mailboxNames: string[] | undefined;
  if (args.mailbox) {
    if (isRole(args.mailbox)) {
      const role = args.mailbox.toLowerCase();
      if (account) {
        mailboxNames = store.mailboxesForRole(account, role);
      } else {
        mailboxNames = (store.raw.prepare("SELECT DISTINCT mailbox_name FROM mailbox_roles WHERE role=?").all(role) as { mailbox_name: string }[]).map((r) => r.mailbox_name);
      }
      if (!mailboxNames.length) mailboxNames = undefined; // no match → don't over-constrain; fall back to none
    } else {
      mailboxNames = [args.mailbox];
    }
  }
  return { account, mailboxNames, anyMailbox: args.anyMailbox };
}
