# Contacts MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/contacts-mcp`, an MCP server that searches/reads/resolves/writes macOS Contacts, reusing the shared `@llm-wiki/applescript` and `@llm-wiki/search` packages.

**Architecture:** Reads come from Apple's per-source AddressBook stores (read-only, FDA), aggregated across `Sources/*/AddressBook-v22.abcddb` and deduped; writes go through AppleScript (Automation). Hybrid keyword+semantic search runs over a connector-owned sidecar index (FTS5 + sqlite-vec) populated by a sync step that embeds via the LLM gateway. `resolve_recipient` turns a free-text descriptor into ranked email-bearing candidates.

**Tech Stack:** TypeScript (ESM, `tsx`), `@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `@llm-wiki/search`, `@llm-wiki/applescript`, `@llm-wiki/embedding`, `node:test`, macOS `osascript`.

## Global Constraints

- AddressBook `.abcddb` stores are opened **read-only and never written** (`new Database(path, { readonly: true, fileMustExist: true })`).
- `packages/embedding` stays pure (no better-sqlite3 / sqlite-vec); the wiki gate must stay green.
- Commit only on the current feature branch; never `main`. Commit trailer exactly: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (heredoc, no apostrophes in the body).
- Embeddings route through the LLM gateway by default (model `local-embed`, endpoint `http://127.0.0.1:4000/v1/embeddings`); `MAIL_EMBED_ENDPOINT=off` disables.
- No new TCC permission: reads use existing FDA, writes use the existing Automation grant.
- All user-supplied strings interpolated into AppleScript only via `esc()` from `@llm-wiki/applescript`.
- `"type": "module"`; test script `node --import tsx --test "test/**/*.test.ts"`.
- The new app must be added explicitly to the root `package.json` `workspaces` array (apps are listed explicitly there; only `packages/*` is globbed).
- Contacts live across `~/Library/Application Support/AddressBook/Sources/<UUID>/AddressBook-v22.abcddb`. Schema: `ZABCDRECORD(Z_PK, ZUNIQUEID, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION, ZNOTE)`; `ZABCDEMAILADDRESS(ZOWNER→Z_PK, ZADDRESS, ZADDRESSNORMALIZED, ZLABEL)`; `ZABCDPHONENUMBER(ZOWNER→Z_PK, ZFULLNUMBER, ZLABEL)`. Labels look like `_$!<Home>!$_` or plain (`Gmail`).

---

## File Structure

`apps/contacts-mcp/src/`
- `paths.ts` — AddressBook source DB paths; sidecar DB path.
- `types.ts` — `Contact`, `ContactEmail`, `ContactPhone`, `ResolvedRecipient`.
- `addressbook-store.ts` — read-only multi-source loader + dedup/merge; `listContacts`/`getContact`/`allForIndex`.
- `index-db.ts` — sidecar schema (mirror + standalone FTS5 + `VectorStore`) + `EventFilter`-style `ContactFilter`.
- `sync.ts` + `embed-config.ts` — incremental index + gateway embedding.
- `search.ts` — hybrid FTS+vector+RRF with pre-limit filters.
- `resolve.ts` — `resolveRecipient`.
- `applescript.ts` — create/update builders + `mapContactsError`.
- `args.ts` — argument validation.
- `cli.ts` — `index`/`sync`/`status`.
- `index.ts` — MCP server.
- `realtest.mts` — manual live, excluded from CI.

---

### Task 1: Scaffold + paths + types + label helper

**Files:**
- Create: `apps/contacts-mcp/package.json`, `apps/contacts-mcp/tsconfig.json`
- Create: `apps/contacts-mcp/src/paths.ts`, `apps/contacts-mcp/src/types.ts`, `apps/contacts-mcp/src/labels.ts`
- Modify: root `package.json` (workspaces)
- Test: `apps/contacts-mcp/test/labels.test.ts`

**Interfaces:**
- Produces: `sourceDbPaths(): string[]`; `indexDbPath(): string`; `cleanLabel(raw: string | null): string | null`; types `Contact`, `ContactEmail`, `ContactPhone`, `ResolvedRecipient`.

- [ ] **Step 1: Manifests**

`apps/contacts-mcp/package.json`:
```json
{
  "name": "@llm-wiki/contacts-mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
  "dependencies": {
    "@llm-wiki/applescript": "*",
    "@llm-wiki/embedding": "*",
    "@llm-wiki/search": "*",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "^0.1.7-alpha.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

`apps/contacts-mcp/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src", "test"]
}
```

Add `"apps/contacts-mcp"` to the root `package.json` `workspaces` array.

- [ ] **Step 2: Write the failing test**

`apps/contacts-mcp/test/labels.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanLabel } from "../src/labels.ts";

test("cleanLabel strips Apple label decoration", () => {
  assert.equal(cleanLabel("_$!<Home>!$_"), "Home");
  assert.equal(cleanLabel("_$!<Work>!$_"), "Work");
});

test("cleanLabel passes through plain labels and null", () => {
  assert.equal(cleanLabel("Gmail"), "Gmail");
  assert.equal(cleanLabel(null), null);
  assert.equal(cleanLabel(""), null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/contacts-mcp && node --import tsx --test test/labels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`apps/contacts-mcp/src/labels.ts`:
```ts
/** Apple stores labels like `_$!<Home>!$_`; unwrap to `Home`. Empty -> null. */
export function cleanLabel(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/^_\$!<(.+?)>!\$_$/);
  const out = (m ? m[1] : raw).trim();
  return out === "" ? null : out;
}
```

`apps/contacts-mcp/src/types.ts`:
```ts
export interface ContactEmail { address: string; label: string | null }
export interface ContactPhone { number: string; label: string | null }

export interface Contact {
  uid: string;
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  nickname: string | null;
  note: string | null;
  emails: ContactEmail[];
  phones: ContactPhone[];
  sources: string[];
}

export interface ResolvedRecipient {
  uid: string;
  displayName: string;
  organization: string | null;
  email: string;
  score: number;
}
```

`apps/contacts-mcp/src/paths.ts`:
```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

/** Every per-source AddressBook store that exists, newest layout first. */
export function sourceDbPaths(): string[] {
  const base = join(homedir(), "Library", "Application Support", "AddressBook");
  const out: string[] = [];
  const sources = join(base, "Sources");
  if (existsSync(sources)) {
    for (const uuid of readdirSync(sources)) {
      const db = join(sources, uuid, "AddressBook-v22.abcddb");
      if (existsSync(db)) out.push(db);
    }
  }
  const top = join(base, "AddressBook-v22.abcddb");
  if (existsSync(top)) out.push(top);
  return out;
}

export function indexDbPath(): string {
  return process.env.CONTACTS_INDEX_DB
    ?? join(homedir(), "Library", "Application Support", "llm-wiki", "contacts-index.sqlitedb");
}
```

- [ ] **Step 5: Run + typecheck**

Run: `npm install` (root), then `cd apps/contacts-mcp && node --import tsx --test test/labels.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/contacts-mcp package.json package-lock.json
git commit -m "feat(contacts-mcp): scaffold + paths + types + label helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `addressbook-store.ts` — multi-source read + dedup

**Files:**
- Create: `apps/contacts-mcp/src/dedup.ts`
- Create: `apps/contacts-mcp/src/addressbook-store.ts`
- Test: `apps/contacts-mcp/test/addressbook-store.test.ts`

**Interfaces:**
- Consumes: `Contact` (types.ts), `cleanLabel` (labels.ts).
- Produces:
  - `dedupKey(c: { emails: { address: string }[]; sourceUuid: string; uniqueId: string }): string`
  - `mergeContacts(a: Contact, b: Contact): Contact`
  - `class AddressBookStore` with `static load(paths: string[]): AddressBookStore`, `listContacts(): Contact[]`, `getContact(uid: string): Contact | undefined`, `allForIndex(): Contact[]`.

- [ ] **Step 1: Write the failing test (seeded `.abcddb`-shaped temp DBs)**

`apps/contacts-mcp/test/addressbook-store.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { AddressBookStore } from "../src/addressbook-store.ts";

function seedSource(tag: string, rows: { pk: number; uid: string; first?: string; last?: string; org?: string; emails?: string[] }[]): string {
  const path = `/tmp/abk-${tag}-${process.pid}-${Math.random()}.abcddb`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD(Z_PK INTEGER PRIMARY KEY, ZUNIQUEID TEXT, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT, ZNOTE TEXT);
    CREATE TABLE ZABCDEMAILADDRESS(Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT, ZADDRESSNORMALIZED TEXT, ZLABEL TEXT);
    CREATE TABLE ZABCDPHONENUMBER(Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT, ZLABEL TEXT);
  `);
  let eid = 1;
  for (const r of rows) {
    db.prepare("INSERT INTO ZABCDRECORD(Z_PK,ZUNIQUEID,ZFIRSTNAME,ZLASTNAME,ZORGANIZATION) VALUES (?,?,?,?,?)")
      .run(r.pk, r.uid, r.first ?? null, r.last ?? null, r.org ?? null);
    for (const e of r.emails ?? []) {
      db.prepare("INSERT INTO ZABCDEMAILADDRESS(Z_PK,ZOWNER,ZADDRESS,ZADDRESSNORMALIZED,ZLABEL) VALUES (?,?,?,?,?)")
        .run(eid++, r.pk, e, e.toLowerCase(), "_$!<Home>!$_");
    }
  }
  db.close();
  return path;
}

test("aggregates people across sources and joins emails", () => {
  const s1 = seedSource("a", [{ pk: 1, uid: "U1", first: "Anna", last: "Bianchi", emails: ["anna@x.com"] }]);
  const s2 = seedSource("b", [{ pk: 1, uid: "U2", org: "Studio", emails: ["info@studio.it"] }]);
  const store = AddressBookStore.load([s1, s2]);
  const all = store.listContacts();
  assert.equal(all.length, 2);
  const anna = all.find((c) => c.firstName === "Anna")!;
  assert.equal(anna.emails[0].address, "anna@x.com");
  assert.equal(anna.emails[0].label, "Home");
});

test("dedupes the same person (same email) appearing in two sources, merging", () => {
  const s1 = seedSource("c", [{ pk: 1, uid: "U1", first: "Carla", emails: ["carla@x.com"] }]);
  const s2 = seedSource("d", [{ pk: 9, uid: "U9", first: "Carla", org: "ACME", emails: ["carla@x.com"] }]);
  const store = AddressBookStore.load([s1, s2]);
  const all = store.listContacts();
  assert.equal(all.length, 1);
  assert.equal(all[0].organization, "ACME"); // merged in from the second source
  assert.equal(all[0].sources.length, 2);
});

test("getContact resolves by uid", () => {
  const s1 = seedSource("e", [{ pk: 1, uid: "U1", first: "Dino", emails: ["dino@x.com"] }]);
  const store = AddressBookStore.load([s1]);
  const uid = store.listContacts()[0].uid;
  assert.equal(store.getContact(uid)?.firstName, "Dino");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/contacts-mcp && node --import tsx --test test/addressbook-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dedup.ts`**

`apps/contacts-mcp/src/dedup.ts`:
```ts
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
```

- [ ] **Step 4: Implement `addressbook-store.ts`**

`apps/contacts-mcp/src/addressbook-store.ts`:
```ts
import Database from "better-sqlite3";
import { basename, dirname } from "node:path";
import { cleanLabel } from "./labels.ts";
import { dedupKey, uidFromKey, mergeContacts } from "./dedup.ts";
import type { Contact } from "./types.ts";

function sourceUuidOf(dbPath: string): string {
  // .../Sources/<uuid>/AddressBook-v22.abcddb  -> <uuid>; top-level -> "default"
  const dir = basename(dirname(dbPath));
  return dir === "AddressBook" ? "default" : dir;
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
            firstName: (p.first as string) ?? null,
            lastName: (p.last as string) ?? null,
            organization: (p.org as string) ?? null,
            nickname: (p.nick as string) ?? null,
            note: (p.note as string) ?? null,
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
```

- [ ] **Step 5: Run + typecheck**

Run: `cd apps/contacts-mcp && node --import tsx --test test/addressbook-store.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/contacts-mcp/src/dedup.ts apps/contacts-mcp/src/addressbook-store.ts apps/contacts-mcp/test/addressbook-store.test.ts
git commit -m "feat(contacts-mcp): read-only multi-source AddressBook reader + dedup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `index-db.ts` — sidecar index

**Files:**
- Create: `apps/contacts-mcp/src/index-db.ts`
- Test: `apps/contacts-mcp/test/index-db.test.ts`

**Interfaces:**
- Consumes: `VectorStore` (`@llm-wiki/search`), `Contact` (types.ts).
- Produces: `interface ContactFilter {}` (reserved; no scalar filters in v1 — see note); `class IndexDb` with `static open(path)`, `getState/setState`, `upsertContact(c: Contact, sourceHash: string): number`, `deleteMissing(keepUids: string[]): number`, `allUids(): string[]`, `embedStateFor(uid)`, `recordEmbed(uid, sourceHash, dim, model)`, `vectors: VectorStore`, `ftsSearch(query: string, limit: number): string[]`, `rowidToUid(rowid)`, `close()`. `displayNameOf(c)` helper exported.

> v1 has no scalar contact filters (account/date make no sense for contacts), so search needs no pre-limit filter pass — the calendar under-return fix does not apply here. `ftsSearch` therefore takes no filter argument.

- [ ] **Step 1: Write the failing test**

`apps/contacts-mcp/test/index-db.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb, displayNameOf } from "../src/index-db.ts";
import type { Contact } from "../src/types.ts";

function c(uid: string, first: string, org: string | null = null): Contact {
  return { uid, firstName: first, lastName: null, organization: org, nickname: null, note: null,
    emails: [{ address: `${first.toLowerCase()}@x.com`, label: null }], phones: [], sources: ["s1"] };
}

test("displayNameOf falls back name -> org -> email", () => {
  assert.equal(displayNameOf(c("U1", "Anna")), "Anna");
  assert.equal(displayNameOf({ ...c("U2", "", null), firstName: null, organization: "ACME" }), "ACME");
});

test("upsert + FTS finds by name token", () => {
  const db = IndexDb.open(":memory:");
  db.upsertContact(c("U1", "Cristian", "Studio Rossi"), "h1");
  db.upsertContact(c("U2", "Marco"), "h2");
  assert.deepEqual(db.ftsSearch('"cristian"', 10), ["U1"]);
  assert.deepEqual(db.ftsSearch('"studio"', 10), ["U1"]);
  db.close();
});

test("deleteMissing removes uids not kept; embed bookkeeping round-trips", () => {
  const db = IndexDb.open(":memory:");
  db.upsertContact(c("U1", "Anna"), "h1");
  db.upsertContact(c("U2", "Bea"), "h2");
  assert.equal(db.deleteMissing(["U1"]), 1);
  assert.deepEqual(db.allUids(), ["U1"]);
  assert.equal(db.embedStateFor("U1"), undefined);
  db.recordEmbed("U1", "h1", 3, "local-embed");
  assert.equal(db.embedStateFor("U1")?.sourceHash, "h1");
  db.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/contacts-mcp && node --import tsx --test test/index-db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/contacts-mcp/src/index-db.ts`:
```ts
import Database from "better-sqlite3";
import { VectorStore } from "@llm-wiki/search";
import type { Contact } from "./types.ts";

export function displayNameOf(c: Contact): string {
  const name = [c.firstName, c.lastName].filter((s) => s && s.trim()).join(" ").trim();
  if (name) return name;
  if (c.organization && c.organization.trim()) return c.organization.trim();
  return c.emails[0]?.address ?? c.uid;
}

export class IndexDb {
  readonly vectors: VectorStore;
  private constructor(private readonly raw: Database.Database) {
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS contacts(
        rowid INTEGER PRIMARY KEY,
        uid TEXT UNIQUE, display_name TEXT, organization TEXT, nickname TEXT, note TEXT,
        primary_email TEXT, source_hash TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(display_name, organization, nickname, note);
      CREATE TABLE IF NOT EXISTS embed_state(uid TEXT PRIMARY KEY, source_hash TEXT, dim INTEGER, model TEXT, embedded_at INTEGER);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
    `);
    this.vectors = new VectorStore(this.raw, {
      table: "vec_contacts",
      getState: (k) => this.getState(k),
      setState: (k, v) => this.setState(k, v),
      onDimReset: () => this.raw.exec("DELETE FROM embed_state"),
    });
  }

  static open(path: string): IndexDb { return new IndexDb(new Database(path)); }

  getState(key: string): string | undefined {
    return (this.raw.prepare("SELECT value FROM state WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  setState(key: string, value: string): void {
    this.raw.prepare("INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  upsertContact(c: Contact, sourceHash: string): number {
    const dn = displayNameOf(c);
    this.raw.prepare(`
      INSERT INTO contacts(uid,display_name,organization,nickname,note,primary_email,source_hash)
      VALUES (@uid,@dn,@org,@nick,@note,@email,@hash)
      ON CONFLICT(uid) DO UPDATE SET display_name=excluded.display_name, organization=excluded.organization,
        nickname=excluded.nickname, note=excluded.note, primary_email=excluded.primary_email, source_hash=excluded.source_hash`)
      .run({ uid: c.uid, dn, org: c.organization, nick: c.nickname, note: c.note, email: c.emails[0]?.address ?? null, hash: sourceHash });
    const rowid = (this.raw.prepare("SELECT rowid FROM contacts WHERE uid=?").get(c.uid) as { rowid: number }).rowid;
    this.raw.prepare("DELETE FROM contacts_fts WHERE rowid=?").run(rowid);
    this.raw.prepare("INSERT INTO contacts_fts(rowid, display_name, organization, nickname, note) VALUES (?,?,?,?,?)")
      .run(rowid, dn, c.organization ?? "", c.nickname ?? "", c.note ?? "");
    return rowid;
  }

  deleteMissing(keepUids: string[]): number {
    const keep = new Set(keepUids);
    let n = 0;
    const delFts = this.raw.prepare("DELETE FROM contacts_fts WHERE rowid=?");
    const del = this.raw.prepare("DELETE FROM contacts WHERE uid=?");
    const delEmbed = this.raw.prepare("DELETE FROM embed_state WHERE uid=?");
    const sel = this.raw.prepare("SELECT rowid FROM contacts WHERE uid=?");
    for (const uid of this.allUids()) {
      if (keep.has(uid)) continue;
      const row = sel.get(uid) as { rowid: number } | undefined;
      if (row) delFts.run(row.rowid);
      del.run(uid);
      delEmbed.run(uid);
      n++;
    }
    return n;
  }

  allUids(): string[] {
    return (this.raw.prepare("SELECT uid FROM contacts").all() as { uid: string }[]).map((r) => r.uid);
  }

  embedStateFor(uid: string): { sourceHash: string } | undefined {
    const r = this.raw.prepare("SELECT source_hash FROM embed_state WHERE uid=?").get(uid) as { source_hash: string } | undefined;
    return r ? { sourceHash: r.source_hash } : undefined;
  }
  recordEmbed(uid: string, sourceHash: string, dim: number, model: string): void {
    this.raw.prepare(`INSERT INTO embed_state(uid,source_hash,dim,model,embedded_at) VALUES (?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET source_hash=excluded.source_hash, dim=excluded.dim, model=excluded.model, embedded_at=excluded.embedded_at`)
      .run(uid, sourceHash, dim, model, Math.floor(Date.now() / 1000));
  }

  ftsSearch(query: string, limit: number): string[] {
    const rows = this.raw.prepare(
      `SELECT c.uid AS uid FROM contacts_fts f JOIN contacts c ON c.rowid = f.rowid
       WHERE contacts_fts MATCH ? ORDER BY rank LIMIT ?`).all(query, limit) as { uid: string }[];
    return rows.map((r) => r.uid);
  }

  rowidToUid(rowid: number): string | undefined {
    return (this.raw.prepare("SELECT uid FROM contacts WHERE rowid=?").get(rowid) as { uid: string } | undefined)?.uid;
  }

  close(): void { this.raw.close(); }
}
```

- [ ] **Step 4: Run + typecheck**

Run: `cd apps/contacts-mcp && node --import tsx --test test/index-db.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/contacts-mcp/src/index-db.ts apps/contacts-mcp/test/index-db.test.ts
git commit -m "feat(contacts-mcp): sidecar index DB (contacts + FTS5 + vec)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `sync.ts` + `embed-config.ts`

**Files:**
- Create: `apps/contacts-mcp/src/embed-config.ts`, `apps/contacts-mcp/src/sync.ts`
- Test: `apps/contacts-mcp/test/sync.test.ts`

**Interfaces:**
- Consumes: `IndexDb`, `displayNameOf`, `Contact`; `embedTexts` (`@llm-wiki/search`); `EmbeddingConfig` (`@llm-wiki/embedding`).
- Produces: `sourceHash(c: Contact): string`; `loadEmbedConfig(env?)`; `syncIndex(deps: { store: { allForIndex(): Contact[] }; index: IndexDb; embedConfig: EmbeddingConfig | null; embedBatch?: (texts: string[], cfg: EmbeddingConfig) => Promise<(number[] | null)[]> }): Promise<{ upserted: number; embedded: number; deleted: number }>`.

- [ ] **Step 1: Write the failing test**

`apps/contacts-mcp/test/sync.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import { syncIndex, sourceHash } from "../src/sync.ts";
import type { Contact } from "../src/types.ts";

function c(uid: string, first: string, org: string | null = null): Contact {
  return { uid, firstName: first, lastName: null, organization: org, nickname: null, note: null,
    emails: [{ address: `${first.toLowerCase()}@x.com`, label: null }], phones: [], sources: ["s1"] };
}

test("syncIndex upserts, embeds new, re-embeds nothing unchanged, deletes vanished", async () => {
  const index = IndexDb.open(":memory:");
  const cfg = { endpoint: "http://x/v1/embeddings", model: "local-embed" };
  const embedBatch = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);
  let people = [c("U1", "Anna"), c("U2", "Bea")];
  const store = { allForIndex: () => people };
  const r1 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r1.upserted, 2);
  assert.equal(r1.embedded, 2);
  const r2 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r2.embedded, 0);
  people = [c("U1", "Anna")];
  const r3 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r3.deleted, 1);
  index.close();
});

test("sourceHash changes when organization changes", () => {
  assert.notEqual(sourceHash(c("U1", "Anna", "A")), sourceHash(c("U1", "Anna", "B")));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/contacts-mcp && node --import tsx --test test/sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/contacts-mcp/src/embed-config.ts`:
```ts
import type { EmbeddingConfig } from "@llm-wiki/embedding";

export function loadEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  const endpoint = env.MAIL_EMBED_ENDPOINT ?? "http://127.0.0.1:4000/v1/embeddings";
  if (!endpoint || endpoint === "off") return null;
  const cfg: EmbeddingConfig = { endpoint, model: env.MAIL_EMBED_MODEL ?? "local-embed" };
  if (env.MAIL_EMBED_API_KEY) cfg.apiKey = env.MAIL_EMBED_API_KEY;
  const dim = env.MAIL_EMBED_DIM ? Number(env.MAIL_EMBED_DIM) : NaN;
  if (Number.isFinite(dim) && dim > 0) cfg.outputDimensionality = dim;
  return cfg;
}
```

`apps/contacts-mcp/src/sync.ts`:
```ts
import { createHash } from "node:crypto";
import { embedTexts } from "@llm-wiki/search";
import type { EmbeddingConfig } from "@llm-wiki/embedding";
import { displayNameOf, type IndexDb } from "./index-db.ts";
import type { Contact } from "./types.ts";

function embedFields(c: Contact): string {
  return [displayNameOf(c), c.organization ?? "", c.nickname ?? "", c.note ?? ""].filter(Boolean).join("\n");
}

export function sourceHash(c: Contact): string {
  return createHash("sha1").update(embedFields(c)).digest("hex");
}

export interface SyncDeps {
  store: { allForIndex(): Contact[] };
  index: IndexDb;
  embedConfig: EmbeddingConfig | null;
  embedBatch?: (texts: string[], cfg: EmbeddingConfig) => Promise<(number[] | null)[]>;
}

export async function syncIndex(deps: SyncDeps): Promise<{ upserted: number; embedded: number; deleted: number }> {
  const contacts = deps.store.allForIndex();
  let upserted = 0;
  const toEmbed: { uid: string; rowid: number; text: string; hash: string }[] = [];
  for (const c of contacts) {
    const hash = sourceHash(c);
    const rowid = deps.index.upsertContact(c, hash);
    upserted++;
    if (deps.embedConfig && deps.index.embedStateFor(c.uid)?.sourceHash !== hash) {
      toEmbed.push({ uid: c.uid, rowid, text: embedFields(c), hash });
    }
  }
  const deleted = deps.index.deleteMissing(contacts.map((c) => c.uid));

  let embedded = 0;
  if (deps.embedConfig && toEmbed.length) {
    const batch = deps.embedBatch ?? embedTexts;
    const vectors = await batch(toEmbed.map((t) => t.text), deps.embedConfig);
    deps.index.vectors.enable();
    for (let i = 0; i < toEmbed.length; i++) {
      const v = vectors[i];
      if (!v) continue;
      deps.index.vectors.ensureTable(v.length);
      deps.index.vectors.upsert(toEmbed[i].rowid, v);
      deps.index.recordEmbed(toEmbed[i].uid, toEmbed[i].hash, v.length, deps.embedConfig.model);
      embedded++;
    }
  }
  return { upserted, embedded, deleted };
}
```

- [ ] **Step 4: Run + typecheck**

Run: `cd apps/contacts-mcp && node --import tsx --test test/sync.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/contacts-mcp/src/embed-config.ts apps/contacts-mcp/src/sync.ts apps/contacts-mcp/test/sync.test.ts
git commit -m "feat(contacts-mcp): incremental sync + gateway embedding

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `search.ts` — hybrid FTS+vector+RRF

**Files:**
- Create: `apps/contacts-mcp/src/search.ts`
- Test: `apps/contacts-mcp/test/search.test.ts`

**Interfaces:**
- Consumes: `IndexDb`, `rrf` (`@llm-wiki/search`).
- Produces: `hybridSearch(deps: { index: IndexDb; embedQuery?: (text: string) => Promise<number[] | null> }, query: string, limit: number): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

`apps/contacts-mcp/test/search.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import { hybridSearch } from "../src/search.ts";
import type { Contact } from "../src/types.ts";

function c(uid: string, first: string, org: string | null = null): Contact {
  return { uid, firstName: first, lastName: null, organization: org, nickname: null, note: null,
    emails: [{ address: `${first.toLowerCase()}@x.com`, label: null }], phones: [], sources: ["s1"] };
}

test("hybrid falls back to FTS-only when no embedder", async () => {
  const index = IndexDb.open(":memory:");
  index.upsertContact(c("U1", "Cristian"), "h1");
  index.upsertContact(c("U2", "Marco"), "h2");
  const out = await hybridSearch({ index }, "cristian", 10);
  assert.deepEqual(out, ["U1"]);
  index.close();
});

test("hybrid merges vector hits with FTS via RRF", async () => {
  const index = IndexDb.open(":memory:");
  const r1 = index.upsertContact(c("U1", "Anna", "Studio Commercialista"), "h1");
  const r2 = index.upsertContact(c("U2", "Bea"), "h2");
  index.vectors.enable();
  index.vectors.ensureTable(3);
  index.vectors.upsert(r1, [1, 0, 0]);
  index.vectors.upsert(r2, [0, 1, 0]);
  // semantic query close to U1 by vector, no FTS token match
  const out = await hybridSearch({ index, embedQuery: async () => [0.95, 0.05, 0] }, "accountant", 10);
  assert.ok(out.includes("U1"));
  index.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/contacts-mcp && node --import tsx --test test/search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/contacts-mcp/src/search.ts`:
```ts
import { rrf } from "@llm-wiki/search";
import type { IndexDb } from "./index-db.ts";

const CANDIDATE_POOL = 200;

/** Tokenize to alphanumeric (unicode) tokens, quote each, OR-join — safe for FTS5 MATCH. */
function ftsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export interface SearchDeps {
  index: IndexDb;
  embedQuery?: (text: string) => Promise<number[] | null>;
}

export async function hybridSearch(deps: SearchDeps, query: string, limit: number): Promise<string[]> {
  const fts = ftsQuery(query);
  const ftsIds = fts ? deps.index.ftsSearch(fts, CANDIDATE_POOL) : [];

  let vecIds: string[] = [];
  if (deps.embedQuery) {
    const qv = await deps.embedQuery(query);
    const dim = Number(deps.index.getState("vec_contacts_dim") ?? 0);
    if (qv && qv.length === dim && dim > 0) {
      deps.index.vectors.enable();
      const hits = deps.index.vectors.knn(qv, CANDIDATE_POOL);
      vecIds = hits.map((h) => deps.index.rowidToUid(h.rowid)).filter((u): u is string => !!u);
    }
  }

  const ordered = vecIds.length ? rrf([ftsIds, vecIds]).map((r) => r.id) : ftsIds;
  return ordered.slice(0, limit);
}
```

- [ ] **Step 4: Run + typecheck**

Run: `cd apps/contacts-mcp && node --import tsx --test test/search.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/contacts-mcp/src/search.ts apps/contacts-mcp/test/search.test.ts
git commit -m "feat(contacts-mcp): hybrid FTS+vector contact search via RRF

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `resolve.ts` — recipient resolution

**Files:**
- Create: `apps/contacts-mcp/src/resolve.ts`
- Test: `apps/contacts-mcp/test/resolve.test.ts`

**Interfaces:**
- Consumes: `hybridSearch` (search.ts), `AddressBookStore` (via a `getContact` accessor), `Contact`, `ResolvedRecipient`, `displayNameOf`.
- Produces: `resolveRecipient(deps: { search: (q: string, limit: number) => Promise<string[]>; getContact: (uid: string) => Contact | undefined }, description: string, limit: number): Promise<ResolvedRecipient[]>`.

> `resolve` takes a `search` function (so tests inject a stub) and a `getContact`; it expands each hit's emails into one `ResolvedRecipient` per email, ranked by hit order, capped at `limit`. Contacts with no email are skipped.

- [ ] **Step 1: Write the failing test**

`apps/contacts-mcp/test/resolve.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRecipient } from "../src/resolve.ts";
import type { Contact } from "../src/types.ts";

function c(uid: string, first: string, emails: string[], org: string | null = null): Contact {
  return { uid, firstName: first, lastName: null, organization: org, nickname: null, note: null,
    emails: emails.map((a) => ({ address: a, label: null })), phones: [], sources: ["s1"] };
}

test("resolveRecipient returns ranked email-bearing candidates, skipping email-less", async () => {
  const byUid = new Map<string, Contact>([
    ["U1", c("U1", "Anna", ["anna@x.com"], "Studio")],
    ["U2", c("U2", "Bea", [])],                 // no email -> skipped
    ["U3", c("U3", "Carlo", ["carlo@y.com", "c2@y.com"])],
  ]);
  const out = await resolveRecipient(
    { search: async () => ["U1", "U2", "U3"], getContact: (u) => byUid.get(u) },
    "studio",
    5,
  );
  assert.deepEqual(out.map((r) => r.email), ["anna@x.com", "carlo@y.com", "c2@y.com"]);
  assert.equal(out[0].displayName, "Anna");
  assert.equal(out[0].organization, "Studio");
  assert.ok(out[0].score >= out[2].score); // earlier hits rank higher
});

test("resolveRecipient respects the limit", async () => {
  const byUid = new Map<string, Contact>([
    ["U1", c("U1", "Anna", ["a@x.com", "a2@x.com"])],
  ]);
  const out = await resolveRecipient({ search: async () => ["U1"], getContact: (u) => byUid.get(u) }, "anna", 1);
  assert.equal(out.length, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/contacts-mcp && node --import tsx --test test/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/contacts-mcp/src/resolve.ts`:
```ts
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
```

- [ ] **Step 4: Run + typecheck**

Run: `cd apps/contacts-mcp && node --import tsx --test test/resolve.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/contacts-mcp/src/resolve.ts apps/contacts-mcp/test/resolve.test.ts
git commit -m "feat(contacts-mcp): resolve_recipient ranked candidates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `applescript.ts` — create/update builders

**Files:**
- Create: `apps/contacts-mcp/src/applescript.ts`
- Test: `apps/contacts-mcp/test/applescript.test.ts`

**Interfaces:**
- Consumes: `esc`, `runOsa`, `OsaExec` (`@llm-wiki/applescript`).
- Produces: `mapContactsError(stderr: string): string`; `buildCreate(a: CreateArgs): string`; `buildUpdate(a: UpdateArgs): string`; runners `createContact(a, exec?): Promise<string>`, `updateContact(a, exec?): Promise<void>`. Types `CreateArgs { firstName?; lastName?; organization?; nickname?; note?; emails?: { address: string; label?: string }[]; phones?: { number: string; label?: string }[] }`, `UpdateArgs extends CreateArgs { uid... }` — see note: update is keyed by AppleScript person `id`, passed as `personId: string`.

> Contacts.app AppleScript references a person by its `id`. The connector's sidecar `uid` is a dedup hash, NOT the AppleScript id. For v1, `update_contact` takes the AppleScript `personId` directly (the create path returns it; a future task can map sidecar uid -> personId). Keep `UpdateArgs = { personId: string } & Partial<CreateArgs>`.

- [ ] **Step 1: Write the failing test**

`apps/contacts-mcp/test/applescript.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreate, mapContactsError, createContact } from "../src/applescript.ts";

test("buildCreate sets name fields and escapes quotes", () => {
  const s = buildCreate({ firstName: 'a"b', lastName: "Rossi", organization: "ACME" });
  assert.match(s, /make new person/);
  assert.match(s, /first name:"a\\"b"/);
  assert.match(s, /organization:"ACME"/);
});

test("buildCreate adds emails as child objects", () => {
  const s = buildCreate({ firstName: "Anna", emails: [{ address: "anna@x.com", label: "Home" }] });
  assert.match(s, /make new email at end of emails of/);
  assert.match(s, /value:"anna@x.com"/);
});

test("mapContactsError explains automation denial", () => {
  assert.match(mapContactsError("-1743 Not authorized"), /Automation/);
});

test("createContact returns the id printed by the script", async () => {
  const id = await createContact({ firstName: "Anna" }, async () => "ABC-123\n");
  assert.equal(id, "ABC-123");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/contacts-mcp && node --import tsx --test test/applescript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/contacts-mcp/src/applescript.ts`:
```ts
import { esc, runOsa, type OsaExec } from "@llm-wiki/applescript";

export interface CreateArgs {
  firstName?: string; lastName?: string; organization?: string; nickname?: string; note?: string;
  emails?: { address: string; label?: string }[];
  phones?: { number: string; label?: string }[];
}
export type UpdateArgs = { personId: string } & CreateArgs;

export function mapContactsError(stderr: string): string {
  if (/-1743\b|Not authorized/i.test(stderr)) {
    return "Automation permission for Contacts is not granted. Allow it in System Settings → Privacy & Security → Automation.";
  }
  if (/-1728\b/i.test(stderr)) return "Contacts could not find that contact (it may have been moved or deleted).";
  if (/-600\b|isn.t running/i.test(stderr)) return "Contacts.app is not running. Open Contacts and try again.";
  return stderr.trim() || "osascript failed";
}

function nameProps(a: CreateArgs): string {
  const p: string[] = [];
  if (a.firstName) p.push(`first name:"${esc(a.firstName)}"`);
  if (a.lastName) p.push(`last name:"${esc(a.lastName)}"`);
  if (a.organization) p.push(`organization:"${esc(a.organization)}"`);
  if (a.nickname) p.push(`nickname:"${esc(a.nickname)}"`);
  if (a.note) p.push(`note:"${esc(a.note)}"`);
  return p.join(", ");
}

function childLines(target: string, a: CreateArgs): string[] {
  const lines: string[] = [];
  for (const e of a.emails ?? []) {
    const lbl = e.label ? `label:"${esc(e.label)}", ` : "";
    lines.push(`  make new email at end of emails of ${target} with properties {${lbl}value:"${esc(e.address)}"}`);
  }
  for (const ph of a.phones ?? []) {
    const lbl = ph.label ? `label:"${esc(ph.label)}", ` : "";
    lines.push(`  make new phone at end of phones of ${target} with properties {${lbl}value:"${esc(ph.number)}"}`);
  }
  return lines;
}

export function buildCreate(a: CreateArgs): string {
  return [
    'tell application "Contacts"',
    `  set p to make new person with properties {${nameProps(a)}}`,
    ...childLines("p", a),
    "  save",
    "  return id of p",
    "end tell",
  ].join("\n");
}

export function buildUpdate(a: UpdateArgs): string {
  const lines = ['tell application "Contacts"', `  set p to (first person whose id is "${esc(a.personId)}")`];
  if (a.firstName) lines.push(`  set first name of p to "${esc(a.firstName)}"`);
  if (a.lastName) lines.push(`  set last name of p to "${esc(a.lastName)}"`);
  if (a.organization) lines.push(`  set organization of p to "${esc(a.organization)}"`);
  if (a.nickname) lines.push(`  set nickname of p to "${esc(a.nickname)}"`);
  if (a.note) lines.push(`  set note of p to "${esc(a.note)}"`);
  lines.push(...childLines("p", a), "  save", '  return "ok"', "end tell");
  return lines.join("\n");
}

const run = (script: string, exec?: OsaExec) => runOsa(script, { exec, mapError: mapContactsError });

export async function createContact(a: CreateArgs, exec?: OsaExec): Promise<string> {
  return (await run(buildCreate(a), exec)).trim();
}
export async function updateContact(a: UpdateArgs, exec?: OsaExec): Promise<void> {
  await run(buildUpdate(a), exec);
}
```

- [ ] **Step 4: Run + typecheck**

Run: `cd apps/contacts-mcp && node --import tsx --test test/applescript.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/contacts-mcp/src/applescript.ts apps/contacts-mcp/test/applescript.test.ts
git commit -m "feat(contacts-mcp): AppleScript create/update builders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: `args.ts` — argument validation

**Files:**
- Create: `apps/contacts-mcp/src/args.ts`
- Test: `apps/contacts-mcp/test/args.test.ts`

**Interfaces:**
- Consumes: `CreateArgs`, `UpdateArgs` (applescript.ts).
- Produces: `requireString(raw, field): string`; `parseSearchArgs(raw): { query: string; limit: number }`; `parseResolveArgs(raw): { description: string; limit: number }`; `parseCreateArgs(raw): CreateArgs`; `parseUpdateArgs(raw): UpdateArgs`.

> `parseCreateArgs` requires at least one of firstName/lastName/organization (a contact with no name and no org is meaningless). emails/phones are validated as arrays of objects with the right string field.

- [ ] **Step 1: Write the failing test**

`apps/contacts-mcp/test/args.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchArgs, parseResolveArgs, parseCreateArgs } from "../src/args.ts";

test("parseSearchArgs requires query, clamps limit", () => {
  assert.throws(() => parseSearchArgs({}), /query/);
  const a = parseSearchArgs({ query: "anna", limit: 999 });
  assert.equal(a.query, "anna");
  assert.equal(a.limit, 50);
});

test("parseResolveArgs requires description, default limit 5", () => {
  assert.equal(parseResolveArgs({ description: "the accountant" }).limit, 5);
});

test("parseCreateArgs requires a name or organization", () => {
  assert.throws(() => parseCreateArgs({ note: "x" }), /name or organization/);
  const a = parseCreateArgs({ organization: "ACME", emails: [{ address: "x@y.com" }] });
  assert.equal(a.organization, "ACME");
  assert.equal(a.emails?.[0].address, "x@y.com");
});

test("parseCreateArgs rejects malformed emails", () => {
  assert.throws(() => parseCreateArgs({ firstName: "A", emails: [{ label: "Home" }] }), /emails/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/contacts-mcp && node --import tsx --test test/args.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/contacts-mcp/src/args.ts`:
```ts
import type { CreateArgs, UpdateArgs } from "./applescript.ts";

type Raw = Record<string, unknown>;

export function requireString(raw: Raw, field: string): string {
  const v = raw[field];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`"${field}" is required and must be a non-empty string`);
  return v;
}
function optString(raw: Raw, field: string): string | undefined {
  const v = raw[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${field}" must be a string`);
  return v;
}
function clampLimit(raw: Raw, def: number): number {
  const v = raw.limit;
  return typeof v === "number" && v >= 1 ? Math.min(Math.floor(v), 50) : def;
}

export function parseSearchArgs(raw: Raw): { query: string; limit: number } {
  return { query: requireString(raw, "query"), limit: clampLimit(raw, 20) };
}
export function parseResolveArgs(raw: Raw): { description: string; limit: number } {
  return { description: requireString(raw, "description"), limit: clampLimit(raw, 5) };
}

function parseEmails(raw: Raw): { address: string; label?: string }[] | undefined {
  const v = raw.emails;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`"emails" must be an array`);
  return v.map((e) => {
    if (!e || typeof e !== "object" || typeof (e as Raw).address !== "string") throw new Error(`each of "emails" needs a string "address"`);
    const o = e as Raw;
    return { address: o.address as string, ...(typeof o.label === "string" ? { label: o.label } : {}) };
  });
}
function parsePhones(raw: Raw): { number: string; label?: string }[] | undefined {
  const v = raw.phones;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`"phones" must be an array`);
  return v.map((p) => {
    if (!p || typeof p !== "object" || typeof (p as Raw).number !== "string") throw new Error(`each of "phones" needs a string "number"`);
    const o = p as Raw;
    return { number: o.number as string, ...(typeof o.label === "string" ? { label: o.label } : {}) };
  });
}

function nameFields(raw: Raw): CreateArgs {
  return {
    firstName: optString(raw, "firstName"),
    lastName: optString(raw, "lastName"),
    organization: optString(raw, "organization"),
    nickname: optString(raw, "nickname"),
    note: optString(raw, "note"),
    emails: parseEmails(raw),
    phones: parsePhones(raw),
  };
}

export function parseCreateArgs(raw: Raw): CreateArgs {
  const a = nameFields(raw);
  if (!a.firstName && !a.lastName && !a.organization) throw new Error("a contact needs at least a name or organization");
  return a;
}
export function parseUpdateArgs(raw: Raw): UpdateArgs {
  return { personId: requireString(raw, "personId"), ...nameFields(raw) };
}
```

- [ ] **Step 4: Run + typecheck**

Run: `cd apps/contacts-mcp && node --import tsx --test test/args.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/contacts-mcp/src/args.ts apps/contacts-mcp/test/args.test.ts
git commit -m "feat(contacts-mcp): MCP argument validation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: `cli.ts` + `index.ts` (MCP server) + realtest + README

**Files:**
- Create: `apps/contacts-mcp/src/cli.ts`, `apps/contacts-mcp/src/index.ts`, `apps/contacts-mcp/realtest.mts`, `apps/contacts-mcp/README.md`

**Interfaces:** Consumes everything above. Produces the runnable CLI + MCP server.

- [ ] **Step 1: Implement `cli.ts`**

`apps/contacts-mcp/src/cli.ts`:
```ts
#!/usr/bin/env -S node --import tsx
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AddressBookStore } from "./addressbook-store.ts";
import { IndexDb } from "./index-db.ts";
import { syncIndex } from "./sync.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { sourceDbPaths, indexDbPath } from "./paths.ts";

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "index" || cmd === "sync") {
    const paths = sourceDbPaths();
    if (paths.length === 0) { console.error("No AddressBook stores found. Grant Full Disk Access."); process.exit(3); }
    const idxPath = indexDbPath();
    mkdirSync(dirname(idxPath), { recursive: true });
    const store = AddressBookStore.load(paths);
    const index = IndexDb.open(idxPath);
    const res = await syncIndex({ store, index, embedConfig: loadEmbedConfig() });
    console.log(`sync: upserted ${res.upserted}, embedded ${res.embedded}, deleted ${res.deleted}`);
    index.close();
  } else if (cmd === "status") {
    const idxPath = indexDbPath();
    if (!existsSync(idxPath)) { console.log("index: not built yet"); return; }
    const index = IndexDb.open(idxPath);
    console.log(`indexed contacts: ${index.allUids().length}`);
    console.log(`db: ${idxPath}`);
    index.close();
  } else {
    console.log("usage: contacts-mcp <index|sync|status>");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Implement `index.ts` (MCP server)**

`apps/contacts-mcp/src/index.ts`:
```ts
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AddressBookStore } from "./addressbook-store.ts";
import { IndexDb } from "./index-db.ts";
import { hybridSearch } from "./search.ts";
import { resolveRecipient } from "./resolve.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { embedText } from "@llm-wiki/search";
import { createContact, updateContact } from "./applescript.ts";
import { parseSearchArgs, parseResolveArgs, parseCreateArgs, parseUpdateArgs, requireString } from "./args.ts";
import { sourceDbPaths, indexDbPath } from "./paths.ts";

const paths = sourceDbPaths();
const store = paths.length ? AddressBookStore.load(paths) : null;
const index = existsSync(indexDbPath()) ? IndexDb.open(indexDbPath()) : null;
if (index) index.vectors.enable();
const embedCfg = loadEmbedConfig();
const embedQuery = embedCfg ? (t: string) => embedText(t, embedCfg) : undefined;
const search = (q: string, limit: number) => index ? hybridSearch({ index, embedQuery }, q, limit) : Promise.resolve([]);

const server = new Server({ name: "contacts", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "search_contacts", description: "Search contacts (hybrid keyword+semantic).", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false } },
    { name: "read_contact", description: "Read one contact by uid.", inputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"], additionalProperties: false } },
    { name: "resolve_recipient", description: "Resolve a free-text description (e.g. 'the accountant') to ranked email-bearing candidates. Returns candidates for confirmation; does not auto-pick.", inputSchema: { type: "object", properties: { description: { type: "string" }, limit: { type: "number" } }, required: ["description"], additionalProperties: false } },
    { name: "create_contact", description: "Create a contact. Needs at least a name or organization.", inputSchema: { type: "object", properties: {
      firstName: { type: "string" }, lastName: { type: "string" }, organization: { type: "string" }, nickname: { type: "string" }, note: { type: "string" },
      emails: { type: "array", items: { type: "object", properties: { address: { type: "string" }, label: { type: "string" } }, required: ["address"] } },
      phones: { type: "array", items: { type: "object", properties: { number: { type: "string" }, label: { type: "string" } }, required: ["number"] } } }, additionalProperties: false } },
    { name: "update_contact", description: "Update a contact by its Contacts app id (personId).", inputSchema: { type: "object", properties: {
      personId: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, organization: { type: "string" }, nickname: { type: "string" }, note: { type: "string" },
      emails: { type: "array", items: { type: "object", properties: { address: { type: "string" }, label: { type: "string" } }, required: ["address"] } },
      phones: { type: "array", items: { type: "object", properties: { number: { type: "string" }, label: { type: "string" } }, required: ["number"] } } }, required: ["personId"], additionalProperties: false } },
  ],
}));

function ok(data: unknown) { return { content: [{ type: "text", text: JSON.stringify(data) }] }; }

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const raw = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "search_contacts": {
        if (!store) throw new Error("No AddressBook stores found. Grant Full Disk Access.");
        const a = parseSearchArgs(raw);
        const uids = index ? await search(a.query, a.limit) : [];
        return ok(uids.map((u) => store.getContact(u)).filter(Boolean).slice(0, a.limit));
      }
      case "read_contact": {
        if (!store) throw new Error("No AddressBook stores found. Grant Full Disk Access.");
        return ok(store.getContact(requireString(raw, "uid")) ?? null);
      }
      case "resolve_recipient": {
        if (!store) throw new Error("No AddressBook stores found. Grant Full Disk Access.");
        const a = parseResolveArgs(raw);
        return ok(await resolveRecipient({ search, getContact: (u) => store.getContact(u) }, a.description, a.limit));
      }
      case "create_contact": return ok({ id: await createContact(parseCreateArgs(raw)) });
      case "update_contact": { await updateContact(parseUpdateArgs(raw)); return ok({ ok: true }); }
      default: throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${req.params.name}`);
    }
  } catch (e) {
    throw new McpError(ErrorCode.InternalError, e instanceof Error ? e.message : String(e));
  }
});

await server.connect(new StdioServerTransport());
```

- [ ] **Step 3: Typecheck the whole app**

Run: `cd apps/contacts-mcp && npx tsc --noEmit`
Expected: tsc clean. Fix any signature drift against earlier tasks.

- [ ] **Step 4: Add `realtest.mts` (live, not in CI)**

`apps/contacts-mcp/realtest.mts`:
```ts
// Manual live check: reads the real AddressBook stores + a create/delete round-trip.
// Run: node --import tsx apps/contacts-mcp/realtest.mts
import { AddressBookStore } from "./src/addressbook-store.ts";
import { sourceDbPaths } from "./src/paths.ts";
import { createContact } from "./src/applescript.ts";
import { runOsa, esc } from "@llm-wiki/applescript";

const store = AddressBookStore.load(sourceDbPaths());
console.log("contacts:", store.listContacts().length);
const id = await createContact({ firstName: "LLMWiki", lastName: "Realtest", organization: "delete me", emails: [{ address: "realtest@example.com", label: "Home" }] });
console.log("created id:", id);
await runOsa(`tell application "Contacts"\n  delete (first person whose id is "${esc(id)}")\n  save\nend tell`, {});
console.log("deleted OK");
```

- [ ] **Step 5: Write `README.md`**

`apps/contacts-mcp/README.md` documenting: FDA for reads (multi-source AddressBook stores), Automation for writes, `contacts-mcp index` to build/refresh the search index (embeddings via the gateway `local-embed`, `MAIL_EMBED_ENDPOINT=off` to disable), the 5 tools, the dedup heuristic (email-first), that `resolve_recipient` returns candidates for confirmation (does not auto-pick), that `update_contact` takes the Contacts-app `personId` (not the sidecar uid), and that destructive writes are gated by the host PreToolUse approval.

- [ ] **Step 6: Run the full app suite + typecheck**

Run: `cd apps/contacts-mcp && npm test && npx tsc --noEmit`
Expected: all unit suites pass (labels, addressbook-store, index-db, sync, search, resolve, applescript, args), tsc clean. (realtest is NOT part of `npm test`.)

- [ ] **Step 7: Commit**

```bash
git add apps/contacts-mcp/src/cli.ts apps/contacts-mcp/src/index.ts apps/contacts-mcp/realtest.mts apps/contacts-mcp/README.md
git commit -m "feat(contacts-mcp): CLI (index/sync/status) + MCP server + realtest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the executor

- No extraction phase: `@llm-wiki/applescript` and `@llm-wiki/search` already exist and are consumed directly.
- The vec dim state key is `vec_contacts_dim` (VectorStore default `${table}_dim` for table `vec_contacts`); `search.ts` reads that literal.
- `realtest.mts` creates and deletes a throwaway contact via AppleScript — never run it in CI; it is outside the `test/**/*.test.ts` glob.
- Unlike calendar-mcp, contacts have no scalar filters (no account/date), so there is no pre-limit-filter concern; `ftsSearch` takes no filter argument and search returns the top `limit` after RRF over a 200-candidate pool.
