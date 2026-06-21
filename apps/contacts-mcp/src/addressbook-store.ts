import Database from "better-sqlite3";
import { basename, dirname } from "node:path";
import { cleanLabel } from "./labels.ts";
import { dedupKey, uidFromKey, mergeContacts } from "./dedup.ts";
import type { Contact } from "./types.ts";

/** SQLite columns are dynamically typed; coerce any non-null value to a string. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : String(v);
}

function sourceUuidOf(dbPath: string): string {
  // .../Sources/<uuid>/AddressBook-v22.abcddb  -> <uuid>; otherwise use the file path as a stable id
  const dir = basename(dirname(dbPath));
  // A UUID looks like 8-4-4-4-12 hex chars; if not a UUID, fall back to the db path itself
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dir)) return dir;
  if (dir === "AddressBook") return "default";
  // Fallback: use the full path so each DB is distinct
  return dbPath;
}

export class AddressBookStore {
  private constructor(private readonly byUid: Map<string, Contact>) {}

  static load(paths: string[]): AddressBookStore {
    const byUid = new Map<string, Contact>();
    for (const path of paths) {
      const sourceUuid = sourceUuidOf(path);
      let db: Database.Database;
      try { db = new Database(path, { readonly: true, fileMustExist: true }); } catch { continue; }
      try {
        const people = db.prepare(
          `SELECT Z_PK pk, ZUNIQUEID uid, ZFIRSTNAME first, ZLASTNAME last,
                  ZORGANIZATION org, ZNICKNAME nick, ZNOTE note
           FROM ZABCDRECORD
           WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL`,
        ).all() as Record<string, unknown>[];
        const emailRows = db.prepare("SELECT ZOWNER owner, ZADDRESS addr, ZLABEL label FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL").all() as Record<string, unknown>[];
        const phoneRows = db.prepare("SELECT ZOWNER owner, ZFULLNUMBER num, ZLABEL label FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL").all() as Record<string, unknown>[];
        const emailsByOwner = new Map<number, Contact["emails"]>();
        for (const r of emailRows) {
          const o = Number(r.owner);
          (emailsByOwner.get(o) ?? emailsByOwner.set(o, []).get(o)!).push({ address: String(r.addr), label: cleanLabel((r.label as string) ?? null) });
        }
        const phonesByOwner = new Map<number, Contact["phones"]>();
        for (const r of phoneRows) {
          const o = Number(r.owner);
          (phonesByOwner.get(o) ?? phonesByOwner.set(o, []).get(o)!).push({ number: String(r.num), label: cleanLabel((r.label as string) ?? null) });
        }
        for (const p of people) {
          const pk = Number(p.pk);
          const emails = emailsByOwner.get(pk) ?? [];
          const phones = phonesByOwner.get(pk) ?? [];
          const uniqueId = String(p.uid ?? pk);
          const key = dedupKey({ emails, sourceUuid, uniqueId });
          const uid = uidFromKey(key);
          const contact: Contact = {
            uid,
            firstName: str(p.first),
            lastName: str(p.last),
            organization: str(p.org),
            nickname: str(p.nick),
            note: str(p.note),
            emails, phones,
            sources: [sourceUuid],
          };
          const existing = byUid.get(uid);
          byUid.set(uid, existing ? mergeContacts(existing, contact) : contact);
        }
      } finally {
        db.close();
      }
    }
    return new AddressBookStore(byUid);
  }

  listContacts(): Contact[] { return [...this.byUid.values()]; }
  getContact(uid: string): Contact | undefined { return this.byUid.get(uid); }
  allForIndex(): Contact[] { return this.listContacts(); }
}
