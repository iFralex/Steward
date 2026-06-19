import type { Store } from "./store.ts";
import { runOsa } from "./osascript.ts";
import { refreshAccounts } from "./accounts.ts";
import { discoverRoles, type Role } from "./mailbox-roles.ts";

const ROLE_BY_SPECIAL: [Role, string][] = [
  ["drafts", "drafts mailbox"],
  ["sent", "sent mailbox"],
  ["trash", "trash mailbox"],
  ["junk", "junk mailbox"],
];

/** Ask Mail for the localized name of each app-level special mailbox: role<TAB>name per line. */
export function localizedRoleTermsScript(): string {
  const lines = ['set TT to (ASCII character 9)', 'set out to ""', 'tell application "Mail"'];
  for (const [role, kw] of ROLE_BY_SPECIAL) {
    lines.push("  try", `    set out to out & "${role}" & TT & (name of ${kw}) & linefeed`, "  end try");
  }
  lines.push("end tell", "return out");
  return lines.join("\n");
}

export function parseLocalizedTerms(out: string): Record<Role, string[]> {
  const t: Record<Role, string[]> = {
    inbox: [], drafts: [], sent: [], trash: [], junk: [], archive: [], important: [], flagged: [],
  };
  for (const line of out.split("\n")) {
    const [role, name] = line.split("\t");
    if (!role || !name) continue;
    const base = name.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase(); // strip "(tutte)"/"(all)"
    if (base && role in t) t[role as Role].push(base);
  }
  return t;
}

export interface RefreshDeps {
  store: Store;
  mailRoot: string;
  exec?: (script: string) => Promise<string>;
  classifyRole?: (name: string) => Promise<Role | null>;
  readMboxCache?: (mailRoot: string, uuid: string) => Promise<{ name: string; attr: number }[]>;
}

export async function refreshIdentity(deps: RefreshDeps): Promise<{ accounts: number; roles: number }> {
  const exec = deps.exec ?? ((s: string) => runOsa(s));
  const accounts = await refreshAccounts(deps.store, exec);
  const uuids = (deps.store.raw.prepare("SELECT uuid FROM accounts").all() as { uuid: string }[]).map((r) => r.uuid);
  const roles = await discoverRoles({
    store: deps.store,
    mailRoot: deps.mailRoot,
    accountUuids: uuids,
    readMboxCache: deps.readMboxCache,
    classifyRole: deps.classifyRole,
    localizedTerms: async () => {
      try {
        return parseLocalizedTerms(await exec(localizedRoleTermsScript()));
      } catch {
        return { inbox: [], drafts: [], sent: [], trash: [], junk: [], archive: [], important: [], flagged: [] };
      }
    },
  });
  return { accounts, roles };
}
