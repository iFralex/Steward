import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Store } from "./store.ts";

export type Role = "inbox" | "drafts" | "sent" | "trash" | "junk" | "archive" | "important" | "flagged";

const BASE = 0x40; // present on most mailboxes; not a role bit
const BITS: [number, Role][] = [
  [0x1000, "drafts"], [0x8000, "sent"], [0x10000, "trash"], [0x4000, "junk"],
  [0x400, "archive"], [0x20000, "important"], [0x2000, "flagged"],
];

/** Map an IMAPMailboxAttributes integer (and name, for INBOX) to a role, or null. */
export function roleFromAttributes(attr: number, name: string): Role | null {
  const a = attr & ~BASE;
  for (const [bit, role] of BITS) if (a & bit) return role;
  if (name.toUpperCase() === "INBOX") return "inbox";
  return null;
}

/** Read an account's .mboxCache.plist via plutil and flatten its mailboxes to {name, attr}. */
export async function readMboxCacheDefault(mailRoot: string, uuid: string): Promise<{ name: string; attr: number }[]> {
  const file = join(mailRoot, uuid, ".mboxCache.plist");
  const json = await new Promise<string>((resolve, reject) => {
    execFile("plutil", ["-convert", "json", "-o", "-", file], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
  const out: { name: string; attr: number }[] = [];
  const walk = (m: Record<string, any>) => {
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (v && typeof v === "object") {
        if (typeof v.IMAPMailboxAttributes === "number") out.push({ name: k, attr: v.IMAPMailboxAttributes });
        if (v.IMAPMailboxChildren) walk(v.IMAPMailboxChildren);
      }
    }
  };
  const root = JSON.parse(json);
  walk(root.mboxes ?? {});
  return out;
}

export interface RoleDiscoveryDeps {
  store: Store;
  mailRoot: string;
  accountUuids: string[];
  readMboxCache?: (mailRoot: string, uuid: string) => Promise<{ name: string; attr: number }[]>;
  classifyRole?: (name: string) => Promise<Role | null>;
  localizedTerms?: () => Promise<Record<Role, string[]>>;
}

/** Discover and persist mailbox roles for the given accounts. Best-effort per account. */
export async function discoverRoles(deps: RoleDiscoveryDeps): Promise<number> {
  const read = deps.readMboxCache ?? readMboxCacheDefault;
  const terms = deps.localizedTerms ? await deps.localizedTerms() : null;
  const hasTerms = terms != null && Object.values(terms).some((l) => l.length > 0);
  let n = 0;
  for (const uuid of deps.accountUuids) {
    let boxes: { name: string; attr: number }[];
    try {
      boxes = await read(deps.mailRoot, uuid);
    } catch {
      continue;
    }
    for (const b of boxes) {
      let role: Role | null = roleFromAttributes(b.attr, b.name);
      if (!role && deps.classifyRole) {
        try { role = await deps.classifyRole(b.name); } catch (err) { role = null; console.warn(`[mail-mirror] mailbox role classifier failed for "${b.name}": ${err instanceof Error ? err.message : String(err)}`); }
      }
      if (!role && hasTerms) {
        const lc = b.name.toLowerCase();
        for (const [r, list] of Object.entries(terms!) as [Role, string[]][]) {
          if (list.some((t) => t && lc.includes(t))) { role = r; break; }
        }
      }
      deps.store.upsertMailboxRole(uuid, b.name, role);
      if (role) n++;
    }
  }
  return n;
}
