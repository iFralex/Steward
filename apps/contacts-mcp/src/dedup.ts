import { createHash } from "node:crypto";
import type { Contact } from "./types.ts";

/** Stable dedup key: primary normalized email if any, else source+uniqueId. */
export function dedupKey(c: { emails: { address: string }[]; sourceUuid: string; uniqueId: string }): string {
  const email = c.emails[0]?.address?.trim().toLowerCase();
  return email ? `email:${email}` : `id:${c.sourceUuid}:${c.uniqueId}`;
}

export function uidFromKey(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 24);
}

function firstNonEmpty(a: string | null, b: string | null): string | null {
  return (a && a.trim() !== "") ? a : ((b && b.trim() !== "") ? b : null);
}

function uniqEmails(list: Contact["emails"]): Contact["emails"] {
  const seen = new Set<string>();
  const out: Contact["emails"] = [];
  for (const e of list) {
    const k = e.address.trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); out.push(e); }
  }
  return out;
}

function uniqPhones(list: Contact["phones"]): Contact["phones"] {
  const seen = new Set<string>();
  const out: Contact["phones"] = [];
  for (const p of list) {
    const k = p.number.replace(/\D/g, "");
    if (k && !seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}

/** Merge two contacts that share a dedup key. First non-empty scalar wins; lists unioned. */
export function mergeContacts(a: Contact, b: Contact): Contact {
  return {
    uid: a.uid,
    firstName: firstNonEmpty(a.firstName, b.firstName),
    lastName: firstNonEmpty(a.lastName, b.lastName),
    organization: firstNonEmpty(a.organization, b.organization),
    nickname: firstNonEmpty(a.nickname, b.nickname),
    note: firstNonEmpty(a.note, b.note),
    emails: uniqEmails([...a.emails, ...b.emails]),
    phones: uniqPhones([...a.phones, ...b.phones]),
    sources: [...new Set([...a.sources, ...b.sources])],
  };
}
