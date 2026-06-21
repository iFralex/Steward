import { displayNameOf } from "./index-db.ts";
import type { Contact, ResolvedRecipient } from "./types.ts";

export interface ResolveDeps {
  search: (q: string, limit: number) => Promise<string[]>;
  getContact: (uid: string) => Contact | undefined;
}

/**
 * Resolve a free-text descriptor into ranked email-bearing candidates. Each
 * email of each matched contact becomes a candidate; earlier search hits score
 * higher. Returns at most `limit` candidates. Does NOT auto-pick one — the
 * caller (agent/user) confirms.
 */
export async function resolveRecipient(deps: ResolveDeps, description: string, limit: number): Promise<ResolvedRecipient[]> {
  const uids = await deps.search(description, Math.max(limit, 10));
  const out: ResolvedRecipient[] = [];
  uids.forEach((uid, rank) => {
    const c = deps.getContact(uid);
    if (!c) return;
    const score = 1 / (rank + 1);
    for (const e of c.emails) {
      out.push({ uid: c.uid, displayName: displayNameOf(c), organization: c.organization, email: e.address, score });
      if (out.length >= limit) return;
    }
  });
  return out.slice(0, limit);
}
