# Plan A — Mail Mirror Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the Apple Mail mirror with account identity, message flags, recipient display names, a trigram substring index, and auto-discovered mailbox roles — kept fresh incrementally — so the search layer (Plan B) can filter and match on them.

**Architecture:** Extend the `.emlx` parser to read the trailing plist (flags / color / Apple thread id), add columns + two FTS variants + three side tables to the better-sqlite3 `Store`, source account identity and mailbox roles via a small AppleScript runner + the on-disk `.mboxCache.plist`, and run all enrichment through the existing `backfill` / `watch` / `reconcile` loop. The schema self-migrates on open so existing DBs upgrade in place.

**Tech Stack:** TypeScript (ESM, `tsx`), better-sqlite3 (SQLite + FTS5 trigram), mailparser, node:test, macOS `osascript` + `plutil`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-19-mail-advanced-search-design.md`.
- `mail-mirror` is the ONLY writer of the DB; `mail-mcp` opens it read-only. Do not change that.
- Do NOT modify `packages/embedding` or anything the wiki imports — the wiki embedding gate (90/90) must stay green and untouched.
- Embeddings are over subject + body only; this plan must NOT change the embedding source text (`sourceTextFor` in `embed.ts`) or trigger re-embedding. New columns (names/flags) are NOT embedded.
- `mail-mirror` must NOT import from `apps/mail-mcp` (dependency direction is mcp → mirror only).
- Mailbox roles are auto-discovered (SPECIAL-USE bits → optional AI → localized terms). NEVER hardcode an author-maintained list of localized mailbox names.
- Tests: `cd apps/mail-mirror && npm test` runs all; a single file: `node --import tsx --test test/<file>.test.ts`. Keep `tsc --noEmit` clean.
- AppleScript is not available in unit tests — all AppleScript/plutil execution is behind an injected function (a runner/exec parameter) so tests pass a stub. Never shell out from a unit test.
- Confirmed `.emlx` plist flag bits (validated on real mail): `read=0x1`, `answered=0x4`, `flagged=0x10`, `junk=0x1000000`. `unread = !read`. Decode the low 32 bits via `(flags >>> 0)`.

---

### Task 1: Schema additions + self-migration on open

**Files:**
- Modify: `apps/mail-mirror/src/store.ts` (the `SCHEMA` constant ~26-63, constructor ~69-75)
- Test: `apps/mail-mirror/test/store-migrate.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `messages` gains columns `answered INTEGER DEFAULT 0`, `junk INTEGER DEFAULT 0`, `flag_color INTEGER`, `apple_thrid INTEGER`, `to_names TEXT`, `cc_names TEXT`. New tables `accounts(uuid TEXT PRIMARY KEY, name TEXT, emails TEXT)`, `mailbox_roles(account_uuid TEXT, mailbox_name TEXT, role TEXT, PRIMARY KEY(account_uuid, mailbox_name))`, and FTS5 `messages_trig` using `tokenize='trigram'` over `(from_name, from_addr, to_names, to_addrs, cc_names, cc_addrs, subject, body_text)`. A private `migrate()` method runs on non-readonly open and is idempotent.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/store-migrate.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Store } from "../src/store.ts";

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
}

test("fresh DB has the new columns and tables", () => {
  const s = Store.open(":memory:");
  const cols = columns(s.raw, "messages");
  for (const c of ["answered", "junk", "flag_color", "apple_thrid", "to_names", "cc_names"]) {
    assert.ok(cols.has(c), `messages.${c} missing`);
  }
  const tables = new Set(
    (s.raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]).map((r) => r.name),
  );
  assert.ok(tables.has("accounts"));
  assert.ok(tables.has("mailbox_roles"));
  assert.ok(tables.has("messages_trig"));
  s.close();
});

test("an old DB missing the new columns is migrated in place", () => {
  const db = new Database(":memory:");
  // Simulate the pre-enrichment messages table (subset of old columns).
  db.exec(`CREATE TABLE messages (
    message_id TEXT PRIMARY KEY, account TEXT NOT NULL, mailbox TEXT,
    from_name TEXT, from_addr TEXT, to_addrs TEXT, cc_addrs TEXT,
    subject TEXT, date INTEGER, snippet TEXT, body_text TEXT,
    body_state TEXT NOT NULL, source TEXT NOT NULL, emlx_path TEXT,
    in_reply_to TEXT, reference_ids TEXT, gm_thrid TEXT, thread_id INTEGER,
    flagged INTEGER DEFAULT 0, unread INTEGER DEFAULT 0, size INTEGER,
    deleted INTEGER DEFAULT 0, ingested_at INTEGER, updated_at INTEGER);`);
  db.exec("INSERT INTO messages(message_id,account,body_state,source) VALUES ('m1','ACC','full','emlx')");
  const s = new Store(db); // non-readonly → migrates
  const cols = columns(s.raw, "messages");
  assert.ok(cols.has("apple_thrid") && cols.has("to_names"));
  assert.equal((s.raw.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c, 1);
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/store-migrate.test.ts`
Expected: FAIL (`messages.answered missing`, no `accounts` table).

- [ ] **Step 3: Implement schema + migration**

In `store.ts`, append the new columns to the `messages` block of `SCHEMA` (after `unread INTEGER DEFAULT 0,` add the new ones) and add the new tables/FTS at the end of `SCHEMA`:

```ts
// inside SCHEMA, messages table column list — add after: flagged INTEGER DEFAULT 0, unread INTEGER DEFAULT 0,
  answered INTEGER DEFAULT 0, junk INTEGER DEFAULT 0, flag_color INTEGER, apple_thrid INTEGER,
  to_names TEXT, cc_names TEXT,
```

Append to the end of the `SCHEMA` template string:

```ts
CREATE TABLE IF NOT EXISTS accounts (
  uuid TEXT PRIMARY KEY, name TEXT, emails TEXT
);
CREATE TABLE IF NOT EXISTS mailbox_roles (
  account_uuid TEXT NOT NULL, mailbox_name TEXT NOT NULL, role TEXT,
  PRIMARY KEY (account_uuid, mailbox_name)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_trig USING fts5(
  from_name, from_addr, to_names, to_addrs, cc_names, cc_addrs, subject, body_text,
  tokenize='trigram'
);
```

Update the constructor to migrate after creating the schema:

```ts
  constructor(db: Database.Database, opts: { readonly?: boolean } = {}) {
    this.raw = db;
    if (!opts.readonly) {
      db.pragma("journal_mode = WAL");
      db.exec(SCHEMA);
      this.migrate();
    }
  }

  /** Idempotently add columns absent from a pre-enrichment DB. CREATE ... IF NOT EXISTS in SCHEMA covers tables. */
  private migrate(): void {
    const have = new Set(
      (this.raw.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((r) => r.name),
    );
    const add: [string, string][] = [
      ["answered", "INTEGER DEFAULT 0"], ["junk", "INTEGER DEFAULT 0"],
      ["flag_color", "INTEGER"], ["apple_thrid", "INTEGER"],
      ["to_names", "TEXT"], ["cc_names", "TEXT"],
    ];
    for (const [col, type] of add) {
      if (!have.has(col)) this.raw.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/store-migrate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/store.ts apps/mail-mirror/test/store-migrate.test.ts
git commit -m "feat(mirror): schema columns + self-migration for flags/names/roles"
```

---

### Task 2: Parse the `.emlx` plist trailer (flags / color / Apple thread id)

**Files:**
- Modify: `apps/mail-mirror/src/emlx.ts`
- Modify: `apps/mail-mirror/src/types.ts` (extend `ParsedMessage`)
- Test: `apps/mail-mirror/test/emlx-flags.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: in `emlx.ts`, exported `decodeFlags(flags: number): { read: boolean; answered: boolean; flagged: boolean; junk: boolean }` and `parsePlistTrailer(buf: Buffer): { flags: number | null; color: number | null; appleThrid: number | null }`. `ParsedMessage` gains `flags: { read: boolean; answered: boolean; flagged: boolean; junk: boolean } | null`, `flagColor: number | null`, `appleThrid: number | null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/emlx-flags.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFlags, parsePlistTrailer } from "../src/emlx.ts";

test("decodeFlags matches real captured ground-truth integers", () => {
  // (flags int, expected) — captured from real Apple Mail messages.
  assert.deepEqual(decodeFlags(8590195840), { read: false, answered: false, flagged: false, junk: false });
  assert.deepEqual(decodeFlags(8590195713), { read: true, answered: false, flagged: false, junk: false });
  assert.deepEqual(decodeFlags(8590195856), { read: false, answered: false, flagged: true, junk: false });
  assert.deepEqual(decodeFlags(8606973056), { read: false, answered: false, flagged: false, junk: true });
  assert.deepEqual(decodeFlags(25770065029), { read: true, answered: true, flagged: false, junk: false });
});

test("parsePlistTrailer extracts flags/color/conversation-id from the trailing plist", () => {
  const trailer = Buffer.from(
    `5\nhello<?xml version="1.0"?>\n<plist version="1.0"><dict>` +
    `<key>color</key><integer>0</integer>` +
    `<key>conversation-id</key><integer>80147</integer>` +
    `<key>flags</key><integer>8590195856</integer>` +
    `</dict></plist>\n`,
  );
  const p = parsePlistTrailer(trailer);
  assert.equal(p.flags, 8590195856);
  assert.equal(p.color, 0);
  assert.equal(p.appleThrid, 80147);
});

test("parsePlistTrailer returns nulls when there is no plist", () => {
  assert.deepEqual(parsePlistTrailer(Buffer.from("3\nhi")), { flags: null, color: null, appleThrid: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/emlx-flags.test.ts`
Expected: FAIL (`decodeFlags is not a function`).

- [ ] **Step 3: Implement the decoder and trailer parser**

Add to `emlx.ts` (near the top, after `normalizeRefs`):

```ts
const FLAG_READ = 0x1;
const FLAG_ANSWERED = 0x4;
const FLAG_FLAGGED = 0x10;
const FLAG_JUNK = 0x1000000;

/** Decode the low 32 bits of the .emlx plist `flags` bitfield. Bits validated on real mail. */
export function decodeFlags(flags: number): { read: boolean; answered: boolean; flagged: boolean; junk: boolean } {
  const lo = flags >>> 0; // keep low 32 bits as unsigned; the flags we read live there
  return {
    read: !!(lo & FLAG_READ),
    answered: !!(lo & FLAG_ANSWERED),
    flagged: !!(lo & FLAG_FLAGGED),
    junk: !!(lo & FLAG_JUNK),
  };
}

function plistInt(xml: string, key: string): number | null {
  const m = new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`).exec(xml);
  return m ? Number(m[1]) : null;
}

/** Read the trailing Apple plist of an .emlx buffer; returns nulls when absent. */
export function parsePlistTrailer(buf: Buffer): { flags: number | null; color: number | null; appleThrid: number | null } {
  const s = buf.toString("utf8");
  const start = s.indexOf("<plist");
  if (start < 0) return { flags: null, color: null, appleThrid: null };
  const xml = s.slice(start);
  return { flags: plistInt(xml, "flags"), color: plistInt(xml, "color"), appleThrid: plistInt(xml, "conversation-id") };
}
```

Extend `ParsedMessage` in `types.ts` (add after `gmThrid`):

```ts
  flags: { read: boolean; answered: boolean; flagged: boolean; junk: boolean } | null;
  flagColor: number | null;
  appleThrid: number | null;
```

In `parseEmlx(buf)`, the function currently slices message bytes for mailparser. Add trailer parsing from the SAME full `buf` and include the fields in the returned object:

```ts
export async function parseEmlx(buf: Buffer): Promise<ParsedMessage> {
  const m = await simpleParser(sliceMessageBytes(buf));
  const trailer = parsePlistTrailer(buf);
  // ... existing field extraction unchanged ...
  return {
    // ... existing fields ...
    gmThrid: typeof gm === "string" ? gm : null,
    flags: trailer.flags != null ? decodeFlags(trailer.flags) : null,
    flagColor: trailer.color,
    appleThrid: trailer.appleThrid,
    attachments,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/emlx-flags.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the existing emlx test to confirm no regression, then commit**

Run: `cd apps/mail-mirror && node --import tsx --test test/emlx.test.ts`
Expected: PASS.

```bash
git add apps/mail-mirror/src/emlx.ts apps/mail-mirror/src/types.ts apps/mail-mirror/test/emlx-flags.test.ts
git commit -m "feat(mirror): parse .emlx plist flags/color/conversation-id"
```

---

### Task 3: Parse recipient / CC display names

**Files:**
- Modify: `apps/mail-mirror/src/emlx.ts`
- Modify: `apps/mail-mirror/src/types.ts` (extend `ParsedMessage`)
- Test: `apps/mail-mirror/test/emlx-names.test.ts` (create)

**Interfaces:**
- Consumes: Task 2's `ParsedMessage`.
- Produces: `ParsedMessage` gains `toNames: string[]` and `ccNames: string[]` (display names aligned with `to`/`cc`; empty string where a recipient has no name).

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/emlx-names.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEmlx } from "../src/emlx.ts";

test("parseEmlx captures recipient and cc display names", async () => {
  const raw =
    "From: A <a@x.com>\r\n" +
    "To: Cristiana Rossi <cris@x.com>, nobody@y.com\r\n" +
    "Cc: Marco Bianchi <marco@z.com>\r\n" +
    "Subject: hi\r\n\r\nbody\r\n";
  const buf = Buffer.from(`${Buffer.byteLength(raw)}\n${raw}`);
  const p = await parseEmlx(buf);
  assert.deepEqual(p.to, ["cris@x.com", "nobody@y.com"]);
  assert.deepEqual(p.toNames, ["Cristiana Rossi", ""]);
  assert.deepEqual(p.cc, ["marco@z.com"]);
  assert.deepEqual(p.ccNames, ["Marco Bianchi"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/emlx-names.test.ts`
Expected: FAIL (`toNames` undefined).

- [ ] **Step 3: Implement name extraction**

In `emlx.ts`, replace the address-only helper with one that also returns names, keeping `to`/`cc` arrays unchanged:

```ts
  const addrParts = (v: typeof m.to) => {
    const list = (Array.isArray(v) ? v : v ? [v] : []).flatMap((g) => g.value).filter((a) => a.address);
    return { addrs: list.map((a) => a.address ?? ""), names: list.map((a) => a.name ?? "") };
  };
  const to = addrParts(m.to);
  const cc = addrParts(m.cc);
```

Use `to.addrs`/`cc.addrs` where `toList`/`ccList` were used, and add to the returned object:

```ts
    to: to.addrs,
    cc: cc.addrs,
    toNames: to.names,
    ccNames: cc.names,
```

Add to `ParsedMessage` in `types.ts` (after `cc`):

```ts
  toNames: string[];
  ccNames: string[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/emlx-names.test.ts && node --import tsx --test test/emlx.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/emlx.ts apps/mail-mirror/src/types.ts apps/mail-mirror/test/emlx-names.test.ts
git commit -m "feat(mirror): capture recipient/cc display names"
```

---

### Task 4: Persist flags/names + maintain the trigram index in the Store

**Files:**
- Modify: `apps/mail-mirror/src/store.ts` (`MessageRow`, `upsertMessage`, `reindexFts`, `rowToMessage`)
- Test: `apps/mail-mirror/test/store-enrich.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's columns + `messages_trig`.
- Produces: `MessageRow` gains `toNames: string[]`, `ccNames: string[]`, `unread: boolean`, `flagged: boolean`, `answered: boolean`, `junk: boolean`, `flagColor: number | null`, `appleThrid: number | null`. `upsertMessage` persists them and reindexes both FTS tables. New method `searchTrig(field: string, needle: string, limit: number): MessageRow[]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/store-enrich.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    messageId: "m1", account: "ACC", mailbox: "INBOX", fromName: "Tom", fromAddr: "a@b",
    to: ["me@x"], cc: [], toNames: ["Cristiana Rossi"], ccNames: [], subject: "Hi", date: 1750000000,
    bodyText: "body", bodyState: "full", source: "emlx", emlxPath: "/p/m1", inReplyTo: null,
    references: [], gmThrid: null, size: 1, unread: true, flagged: true, answered: false, junk: false,
    flagColor: 2, appleThrid: 80147, ...over,
  };
}

test("upsertMessage persists flags, names, color and apple_thrid", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  const r = s.raw.prepare("SELECT unread, flagged, answered, junk, flag_color, apple_thrid, to_names FROM messages WHERE message_id='m1'").get() as Record<string, unknown>;
  assert.equal(r.unread, 1);
  assert.equal(r.flagged, 1);
  assert.equal(r.answered, 0);
  assert.equal(r.flag_color, 2);
  assert.equal(r.apple_thrid, 80147);
  assert.equal(JSON.parse(r.to_names as string)[0], "Cristiana Rossi");
  s.close();
});

test("trigram index matches an arbitrary substring inside a recipient name", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  const hits = s.searchTrig("to_names", "ristian", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1");
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/store-enrich.test.ts`
Expected: FAIL (`MessageRow` lacks `toNames`; `searchTrig` not a function).

- [ ] **Step 3: Implement**

Extend `MessageRow` (after `size`):

```ts
  toNames: string[];
  ccNames: string[];
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  junk: boolean;
  flagColor: number | null;
  appleThrid: number | null;
```

In `upsertMessage`, add the columns to the INSERT column list, the `VALUES`, the `ON CONFLICT ... DO UPDATE SET`, and the bound params. Add to columns:
`to_names, cc_names, unread, flagged, answered, junk, flag_color, apple_thrid` and matching `@to_names,...`. Add to the conflict update:
`to_names=excluded.to_names, cc_names=excluded.cc_names, unread=excluded.unread, flagged=excluded.flagged, answered=excluded.answered, junk=excluded.junk, flag_color=excluded.flag_color, apple_thrid=excluded.apple_thrid,`
Add to the bound object:

```ts
        to_names: JSON.stringify(r.toNames), cc_names: JSON.stringify(r.ccNames),
        unread: r.unread ? 1 : 0, flagged: r.flagged ? 1 : 0,
        answered: r.answered ? 1 : 0, junk: r.junk ? 1 : 0,
        flag_color: r.flagColor, apple_thrid: r.appleThrid,
```

After `this.reindexFts(r.messageId);` add `this.reindexTrig(r.messageId);`. Implement `reindexTrig` mirroring `reindexFts`:

```ts
  private reindexTrig(messageId: string): void {
    const m = this.raw.prepare(
      "SELECT rowid, from_name, from_addr, to_names, to_addrs, cc_names, cc_addrs, subject, body_text FROM messages WHERE message_id=?",
    ).get(messageId) as
      | { rowid: number; from_name: string; from_addr: string; to_names: string; to_addrs: string; cc_names: string; cc_addrs: string; subject: string; body_text: string }
      | undefined;
    if (!m) return;
    this.raw.prepare("DELETE FROM messages_trig WHERE rowid=?").run(m.rowid);
    this.raw.prepare(
      "INSERT INTO messages_trig(rowid, from_name, from_addr, to_names, to_addrs, cc_names, cc_addrs, subject, body_text) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(m.rowid, m.from_name, m.from_addr, m.to_names, m.to_addrs, m.cc_names, m.cc_addrs, m.subject, m.body_text);
  }

  /** Substring/fuzzy match in one trigram field. `field` must be a known column name. */
  searchTrig(field: string, needle: string, limit: number): MessageRow[] {
    const cols = new Set(["from_name", "from_addr", "to_names", "to_addrs", "cc_names", "cc_addrs", "subject", "body_text"]);
    if (!cols.has(field)) throw new Error(`unknown trigram field: ${field}`);
    const rows = this.raw.prepare(
      `SELECT m.* FROM messages_trig t JOIN messages m ON m.rowid=t.rowid
       WHERE t.${field} MATCH ? AND m.deleted=0 ORDER BY rank LIMIT ?`,
    ).all(`"${needle.replace(/"/g, '""')}"`, limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }
```

Extend `rowToMessage` to read the new columns:

```ts
    toNames: JSON.parse((m.to_names as string) || "[]"),
    ccNames: JSON.parse((m.cc_names as string) || "[]"),
    unread: !!(m.unread as number),
    flagged: !!(m.flagged as number),
    answered: !!(m.answered as number),
    junk: !!(m.junk as number),
    flagColor: (m.flag_color as number) ?? null,
    appleThrid: (m.apple_thrid as number) ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/store-enrich.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run store + sync tests (MessageRow shape changed) and fix any constructors, then commit**

Run: `cd apps/mail-mirror && npm test`
Expected: failures only in tests that build a `MessageRow` literal without the new fields. Update those literals to include the new fields (`toNames: [], ccNames: [], unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null`). Re-run until green.

```bash
git add apps/mail-mirror/src/store.ts apps/mail-mirror/test/
git commit -m "feat(mirror): persist flags/names + trigram index"
```

---

### Task 5: Wire parsed flags/names into ingest

**Files:**
- Modify: `apps/mail-mirror/src/sync.ts` (`ingestEmlxFile`, the `row` literal ~84-102)
- Test: `apps/mail-mirror/test/sync-enrich.test.ts` (create)

**Interfaces:**
- Consumes: `ParsedMessage` (Tasks 2-3), `MessageRow` (Task 4).
- Produces: ingested rows carry flags/names/color/appleThrid.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/sync-enrich.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { ingestEmlxFile } from "../src/sync.ts";

test("ingest carries flags and recipient names from the emlx", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-enrich-"));
  const raw =
    "From: A <a@x.com>\r\nTo: Cristiana Rossi <cris@x.com>\r\nMessage-ID: <m1@x>\r\nSubject: hi\r\n\r\nbody\r\n";
  // flags 8590195856 = flagged, not read → unread=true, flagged=true
  const emlx = `${Buffer.byteLength(raw)}\n${raw}<plist version="1.0"><dict><key>flags</key><integer>8590195856</integer></dict></plist>\n`;
  const path = join(dir, "1.emlx");
  writeFileSync(path, emlx);
  const store = Store.open(":memory:");
  const blobs = new BlobStore(join(dir, "blobs"));
  await ingestEmlxFile({ store, blobs }, { path, account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 });
  const m = store.getMessage("m1@x")!;
  assert.equal(m.unread, true);
  assert.equal(m.flagged, true);
  assert.deepEqual(m.toNames, ["Cristiana Rossi"]);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/sync-enrich.test.ts`
Expected: FAIL (`m.unread` is false / `toNames` empty — fields not wired).

- [ ] **Step 3: Implement — extend the `row` literal in `ingestEmlxFile`**

Add to the `row: MessageRow = { ... }` object (after `size`):

```ts
    toNames: parsed.toNames,
    ccNames: parsed.ccNames,
    unread: parsed.flags ? !parsed.flags.read : false,
    flagged: parsed.flags ? parsed.flags.flagged : false,
    answered: parsed.flags ? parsed.flags.answered : false,
    junk: parsed.flags ? parsed.flags.junk : false,
    flagColor: parsed.flagColor,
    appleThrid: parsed.appleThrid,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/sync-enrich.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/sync.ts apps/mail-mirror/test/sync-enrich.test.ts
git commit -m "feat(mirror): wire flags/names into ingest"
```

---

### Task 6: AppleScript runner + account identity sourcing

**Files:**
- Create: `apps/mail-mirror/src/osascript.ts`
- Create: `apps/mail-mirror/src/accounts.ts`
- Modify: `apps/mail-mirror/src/store.ts` (account methods)
- Test: `apps/mail-mirror/test/accounts.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `accounts` table.
- Produces:
  - `osascript.ts`: `runOsa(script: string, timeoutMs?: number): Promise<string>` (thin `execFile` wrapper; default 30000ms).
  - `accounts.ts`: `accountsScript(): string`; `parseAccounts(out: string): { uuid: string; name: string; emails: string[] }[]`; `refreshAccounts(store: Store, exec?: (script: string) => Promise<string>): Promise<number>` (returns count; swallows AppleScript errors → returns 0).
  - `store.ts`: `upsertAccount(uuid: string, name: string, emails: string[]): void`; `hasAccount(uuid: string): boolean`; `accountByEmailOrName(q: string): string | undefined` (returns the matching UUID or undefined).

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/accounts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { parseAccounts, refreshAccounts } from "../src/accounts.ts";

test("parseAccounts splits id|name|emails lines", () => {
  const out = "UUID1\tGoogle\ta@x.com,b@x.com\nUUID2\tWork\tc@y.com\n";
  assert.deepEqual(parseAccounts(out), [
    { uuid: "UUID1", name: "Google", emails: ["a@x.com", "b@x.com"] },
    { uuid: "UUID2", name: "Work", emails: ["c@y.com"] },
  ]);
});

test("refreshAccounts upserts and account lookup resolves by email or name", async () => {
  const s = Store.open(":memory:");
  const stub = async () => "UUID1\tGoogle\ta@x.com,b@x.com\n";
  const n = await refreshAccounts(s, stub);
  assert.equal(n, 1);
  assert.equal(s.accountByEmailOrName("b@x.com"), "UUID1");
  assert.equal(s.accountByEmailOrName("google"), "UUID1");
  assert.equal(s.accountByEmailOrName("nope"), undefined);
  assert.ok(s.hasAccount("UUID1"));
  s.close();
});

test("refreshAccounts returns 0 when AppleScript fails", async () => {
  const s = Store.open(":memory:");
  const n = await refreshAccounts(s, async () => { throw new Error("no Mail"); });
  assert.equal(n, 0);
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/accounts.test.ts`
Expected: FAIL (module `accounts.ts` not found).

- [ ] **Step 3: Implement**

`osascript.ts`:

```ts
import { execFile } from "node:child_process";

/** Run an AppleScript via osascript and resolve its stdout. Mirror is the only AppleScript user here. */
export function runOsa(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || "osascript failed"));
      else resolve(stdout);
    });
  });
}
```

`accounts.ts`:

```ts
import type { Store } from "./store.ts";
import { runOsa } from "./osascript.ts";

/** Emit one TAB-separated line per account: id<TAB>name<TAB>comma-joined emails. */
export function accountsScript(): string {
  return [
    "set TT to (ASCII character 9)",
    "set savedTID to AppleScript's text item delimiters",
    'set AppleScript\'s text item delimiters to ","',
    'set out to ""',
    'tell application "Mail"',
    "  repeat with a in accounts",
    '    set em to ""',
    "    try",
    "      set em to ((email addresses of a) as string)",
    "    end try",
    "    set out to out & (id of a) & TT & (name of a) & TT & em & linefeed",
    "  end repeat",
    "end tell",
    "set AppleScript's text item delimiters to savedTID",
    "return out",
  ].join("\n");
}

export function parseAccounts(out: string): { uuid: string; name: string; emails: string[] }[] {
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => {
      const [uuid, name, emails] = l.split("\t");
      return {
        uuid: (uuid ?? "").trim(),
        name: (name ?? "").trim(),
        emails: (emails ?? "").split(",").map((e) => e.trim()).filter(Boolean),
      };
    })
    .filter((a) => a.uuid);
}

/** Refresh the accounts table from Mail. Best-effort: returns 0 (and changes nothing) on any AppleScript error. */
export async function refreshAccounts(store: Store, exec: (script: string) => Promise<string> = (s) => runOsa(s)): Promise<number> {
  let out: string;
  try {
    out = await exec(accountsScript());
  } catch {
    return 0;
  }
  const accts = parseAccounts(out);
  for (const a of accts) store.upsertAccount(a.uuid, a.name, a.emails);
  return accts.length;
}
```

Add to `store.ts`:

```ts
  upsertAccount(uuid: string, name: string, emails: string[]): void {
    this.raw.prepare(
      `INSERT INTO accounts(uuid, name, emails) VALUES (?,?,?)
       ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, emails=excluded.emails`,
    ).run(uuid, name, emails.join(","));
  }

  hasAccount(uuid: string): boolean {
    return this.raw.prepare("SELECT 1 FROM accounts WHERE uuid=? LIMIT 1").get(uuid) !== undefined;
  }

  /** Resolve a friendly email or account name (case-insensitive substring) to its account UUID. */
  accountByEmailOrName(q: string): string | undefined {
    const needle = `%${q.toLowerCase()}%`;
    const r = this.raw.prepare(
      "SELECT uuid FROM accounts WHERE lower(emails) LIKE ? OR lower(name) LIKE ? LIMIT 1",
    ).get(needle, needle) as { uuid: string } | undefined;
    return r?.uuid;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/accounts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/osascript.ts apps/mail-mirror/src/accounts.ts apps/mail-mirror/src/store.ts apps/mail-mirror/test/accounts.test.ts
git commit -m "feat(mirror): account identity (accounts table + AppleScript source)"
```

---

### Task 7: Mailbox role discovery (SPECIAL-USE → AI → localized terms)

**Files:**
- Create: `apps/mail-mirror/src/mailbox-roles.ts`
- Modify: `apps/mail-mirror/src/store.ts` (role methods)
- Test: `apps/mail-mirror/test/mailbox-roles.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `mailbox_roles` table; the message_paths mailbox names already in the DB.
- Produces:
  - `mailbox-roles.ts`: type `Role = "inbox" | "drafts" | "sent" | "trash" | "junk" | "archive" | "important" | "flagged"`; `roleFromAttributes(attr: number, name: string): Role | null`; `discoverRoles(deps: RoleDiscoveryDeps): Promise<number>` where `RoleDiscoveryDeps = { store: Store; mailRoot: string; accountUuids: string[]; readMboxCache?: (mailRoot: string, uuid: string) => Promise<{ name: string; attr: number }[]>; classifyRole?: (name: string) => Promise<Role | null>; localizedTerms?: () => Promise<Record<Role, string[]>> }`.
  - `store.ts`: `upsertMailboxRole(accountUuid: string, mailbox: string, role: Role | null): void`; `roleForMailbox(accountUuid: string, mailbox: string): string | undefined`; `mailboxesForRole(accountUuid: string, role: string): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/mailbox-roles.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { roleFromAttributes, discoverRoles } from "../src/mailbox-roles.ts";

test("roleFromAttributes decodes real SPECIAL-USE bits (base 0x40 masked)", () => {
  assert.equal(roleFromAttributes(64 + 0x1000, "Bozze"), "drafts");
  assert.equal(roleFromAttributes(64 + 0x8000, "Posta inviata"), "sent");
  assert.equal(roleFromAttributes(64 + 0x10000, "Cestino"), "trash");
  assert.equal(roleFromAttributes(64 + 0x4000, "Spam"), "junk");
  assert.equal(roleFromAttributes(64 + 0x400, "Tutti i messaggi"), "archive");
  assert.equal(roleFromAttributes(64 + 0x20000, "Importanti"), "important");
  assert.equal(roleFromAttributes(64, "INBOX"), "inbox");
  assert.equal(roleFromAttributes(0, "RandomFolder"), null);
});

test("discoverRoles: SPECIAL-USE first, AI fallback for an attribute-less name, then localized terms", async () => {
  const s = Store.open(":memory:");
  const readMboxCache = async () => [
    { name: "Posta inviata", attr: 64 + 0x8000 }, // SPECIAL-USE → sent
    { name: "Quarantena", attr: 0 },              // no bit → AI
    { name: "Bozze", attr: 0 },                   // no bit, AI says none → localized term
  ];
  const classifyRole = async (n: string) => (n === "Quarantena" ? "junk" : null);
  const localizedTerms = async () => ({
    inbox: [], drafts: ["bozze"], sent: [], trash: [], junk: [], archive: [], important: [], flagged: [],
  });
  await discoverRoles({ store: s, mailRoot: "/x", accountUuids: ["U1"], readMboxCache, classifyRole, localizedTerms });
  assert.equal(s.roleForMailbox("U1", "Posta inviata"), "sent");
  assert.equal(s.roleForMailbox("U1", "Quarantena"), "junk");
  assert.equal(s.roleForMailbox("U1", "Bozze"), "drafts");
  assert.deepEqual(s.mailboxesForRole("U1", "sent"), ["Posta inviata"]);
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/mailbox-roles.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`mailbox-roles.ts`:

```ts
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
        try { role = await deps.classifyRole(b.name); } catch { role = null; }
      }
      if (!role && terms) {
        const lc = b.name.toLowerCase();
        for (const [r, list] of Object.entries(terms) as [Role, string[]][]) {
          if (list.some((t) => t && lc.includes(t))) { role = r; break; }
        }
      }
      deps.store.upsertMailboxRole(uuid, b.name, role);
      if (role) n++;
    }
  }
  return n;
}
```

Add to `store.ts`:

```ts
  upsertMailboxRole(accountUuid: string, mailbox: string, role: string | null): void {
    this.raw.prepare(
      `INSERT INTO mailbox_roles(account_uuid, mailbox_name, role) VALUES (?,?,?)
       ON CONFLICT(account_uuid, mailbox_name) DO UPDATE SET role=excluded.role`,
    ).run(accountUuid, mailbox, role);
  }

  roleForMailbox(accountUuid: string, mailbox: string): string | undefined {
    const r = this.raw.prepare("SELECT role FROM mailbox_roles WHERE account_uuid=? AND mailbox_name=?").get(accountUuid, mailbox) as { role: string | null } | undefined;
    return r?.role ?? undefined;
  }

  mailboxesForRole(accountUuid: string, role: string): string[] {
    return (this.raw.prepare("SELECT mailbox_name FROM mailbox_roles WHERE account_uuid=? AND role=?").all(accountUuid, role) as { mailbox_name: string }[]).map((r) => r.mailbox_name);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/mailbox-roles.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/mailbox-roles.ts apps/mail-mirror/src/store.ts apps/mail-mirror/test/mailbox-roles.test.ts
git commit -m "feat(mirror): auto-discover mailbox roles (SPECIAL-USE/AI/localized)"
```

---

### Task 8: mtime-based re-ingest of modified `.emlx`

**Files:**
- Modify: `apps/mail-mirror/src/store.ts` (`recordPath` to store mtime; a `pathMtime` lookup)
- Modify: `apps/mail-mirror/src/sync.ts` (`reconcile`)
- Test: `apps/mail-mirror/test/sync-mtime.test.ts` (create)

**Interfaces:**
- Consumes: `message_paths`.
- Produces: `message_paths` gains a `mtime_ms REAL` column (added in Task 1? No — add here via the same `migrate()` pattern for `message_paths`). `Store.recordPath(messageId, path, mailbox, isPartial, mtimeMs?)` records mtime; `Store.pathMtime(path): number | undefined`. `reconcile` re-ingests a known path whose on-disk mtime is newer than the stored one.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/sync-mtime.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { reconcile } from "../src/sync.ts";

function emlx(flagsInt: number): string {
  const raw = "From: a@x\r\nTo: b@x\r\nMessage-ID: <m1@x>\r\nSubject: s\r\n\r\nbody\r\n";
  return `${Buffer.byteLength(raw)}\n${raw}<plist><dict><key>flags</key><integer>${flagsInt}</integer></dict></plist>\n`;
}

test("reconcile re-ingests an emlx whose mtime advanced (flag change propagates)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-mtime-"));
  // Lay out a realistic V10/<acct>/INBOX.mbox/<uuid>/Data/.../1.emlx so the locator assigns account+mailbox.
  const root = join(dir, "V10");
  const box = join(root, "ACC", "INBOX.mbox", "U", "Data");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(box, { recursive: true });
  const path = join(box, "1.emlx");
  writeFileSync(path, emlx(8590195840)); // unread, not flagged
  const store = Store.open(":memory:");
  const blobs = new BlobStore(join(dir, "blobs"));
  await reconcile({ store, blobs }, root);
  assert.equal(store.getMessage("m1@x")!.flagged, false);

  writeFileSync(path, emlx(8590195856)); // now flagged
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // bump mtime forward
  await reconcile({ store, blobs }, root);
  assert.equal(store.getMessage("m1@x")!.flagged, true);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/sync-mtime.test.ts`
Expected: FAIL (second assertion: `flagged` still false — reconcile skips known paths).

- [ ] **Step 3: Implement**

In `store.ts` `migrate()`, also migrate `message_paths`:

```ts
    const mp = new Set((this.raw.prepare("PRAGMA table_info(message_paths)").all() as { name: string }[]).map((r) => r.name));
    if (!mp.has("mtime_ms")) this.raw.exec("ALTER TABLE message_paths ADD COLUMN mtime_ms REAL");
```

Add `mtime_ms REAL` to the `message_paths` block of `SCHEMA` for fresh DBs. Extend `recordPath` and add `pathMtime`:

```ts
  recordPath(messageId: string, path: string, mailbox: string, isPartial: boolean, mtimeMs?: number): void {
    this.raw.prepare(
      `INSERT INTO message_paths(path, message_id, mailbox, is_partial, mtime_ms) VALUES(?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET message_id=excluded.message_id, mailbox=excluded.mailbox,
         is_partial=excluded.is_partial, mtime_ms=excluded.mtime_ms`,
    ).run(path, messageId, mailbox, isPartial ? 1 : 0, mtimeMs ?? null);
  }

  pathMtime(path: string): number | undefined {
    const r = this.raw.prepare("SELECT mtime_ms FROM message_paths WHERE path=?").get(path) as { mtime_ms: number | null } | undefined;
    return r?.mtime_ms ?? undefined;
  }
```

In `sync.ts` `ingestEmlxFile`, pass the mtime through `recordPath`:

```ts
  deps.store.recordPath(messageId, entry.path, entry.mailbox, entry.isPartial, entry.mtimeMs);
```

In `reconcile`, re-ingest known-but-modified paths:

```ts
  for (const e of entries) {
    if (!known.has(e.path)) {
      if (await ingestEmlxFile(deps, e)) ingested++;
    } else {
      const prev = deps.store.pathMtime(e.path);
      if (prev === undefined || e.mtimeMs > prev) {
        if (await ingestEmlxFile(deps, e)) ingested++;
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/sync-mtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Run multipath + backfill tests (recordPath signature changed) then commit**

Run: `cd apps/mail-mirror && node --import tsx --test test/sync.multipath.test.ts test/sync.backfill.test.ts test/sync.ingest.test.ts`
Expected: PASS (the new param is optional; existing calls compile).

```bash
git add apps/mail-mirror/src/store.ts apps/mail-mirror/src/sync.ts apps/mail-mirror/test/sync-mtime.test.ts
git commit -m "feat(mirror): re-ingest modified emlx by mtime (flag freshness)"
```

---

### Task 9: Refresh accounts + roles in backfill/reconcile/watch; AI classifier + localized-terms wiring; `migrate` CLI

**Files:**
- Modify: `apps/mail-mirror/src/sync.ts` (`backfill`, `reconcile` — refresh accounts when unknown account seen)
- Create: `apps/mail-mirror/src/enrich.ts` (one `refreshIdentity(store, mailRoot, exec?, classifyRole?)` orchestrator + localized-terms AppleScript)
- Modify: `apps/mail-mirror/src/cli.ts` (`backfill`/`reconcile`/`watch`/`status` call it; new `migrate` command)
- Test: `apps/mail-mirror/test/enrich.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 6-7 (`refreshAccounts`, `discoverRoles`), Task 4 (`searchTrig`).
- Produces:
  - `enrich.ts`: `refreshIdentity(deps: { store: Store; mailRoot: string; exec?: (s: string) => Promise<string>; classifyRole?: (n: string) => Promise<import("./mailbox-roles.ts").Role | null> }): Promise<{ accounts: number; roles: number }>` — refreshes accounts, then discovers roles for every account UUID in the `accounts` table, using the AppleScript localized-terms fetch as the role fallback. `localizedRoleTermsScript(): string` and `parseLocalizedTerms(out: string): Record<Role,string[]>`.
  - `cli.ts`: `migrate` command that re-parses every known `.emlx`, then calls `refreshIdentity`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/enrich.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { refreshIdentity, parseLocalizedTerms } from "../src/enrich.ts";

test("parseLocalizedTerms maps role<TAB>term lines, stripping unified suffix", () => {
  const out = "drafts\tBozze (tutte)\nsent\tInviate (tutte)\ntrash\tCestino (tutte)\njunk\tIndesiderata (tutte)\n";
  const t = parseLocalizedTerms(out);
  assert.deepEqual(t.drafts, ["bozze"]);
  assert.deepEqual(t.junk, ["indesiderata"]);
});

test("refreshIdentity populates accounts then discovers roles for each", async () => {
  const s = Store.open(":memory:");
  const exec = async (script: string) => {
    if (script.includes("email addresses")) return "U1\tGoogle\ta@x.com\n";
    return "drafts\tBozze\n"; // localized terms
  };
  // No SPECIAL-USE on disk in this test → use the localized fallback.
  const r = await refreshIdentity({
    store: s, mailRoot: "/x", exec,
    // inject a readMboxCache via classifyRole=null by stubbing discoverRoles' source through enrich's own seam:
  });
  assert.equal(r.accounts, 1);
  assert.ok(s.hasAccount("U1"));
  s.close();
});
```

> Note: `refreshIdentity` must accept an optional `readMboxCache` seam so this test does not touch the filesystem. Add `readMboxCache?` to its deps and forward it to `discoverRoles`. In the test above, pass `readMboxCache: async () => [{ name: "Bozze", attr: 0 }]` and assert `s.roleForMailbox("U1","Bozze") === "drafts"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/enrich.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`enrich.ts`:

```ts
import type { Store } from "./store.ts";
import { runOsa } from "./osascript.ts";
import { refreshAccounts } from "./accounts.ts";
import { discoverRoles, type Role } from "./mailbox-roles.ts";

const ROLE_BY_SPECIAL: [Role, string][] = [
  ["drafts", "drafts mailbox"], ["sent", "sent mailbox"], ["trash", "trash mailbox"], ["junk", "junk mailbox"],
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
  const t: Record<Role, string[]> = { inbox: [], drafts: [], sent: [], trash: [], junk: [], archive: [], important: [], flagged: [] };
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
      try { return parseLocalizedTerms(await exec(localizedRoleTermsScript())); } catch {
        return { inbox: [], drafts: [], sent: [], trash: [], junk: [], archive: [], important: [], flagged: [] };
      }
    },
  });
  return { accounts, roles };
}
```

In `sync.ts`, after a successful ingest of a path whose account is unknown, refresh accounts so a freshly added account is named promptly. Add at the top of `reconcile`, after counting `ingested`, a lightweight guard: collect any `entry.account` not in `accounts` and, if found, call `refreshAccounts(deps.store)` once (import it). Keep it best-effort:

```ts
  // Newly appeared account? refresh identity so its name/emails/roles are known.
  const unknown = entries.find((e) => !deps.store.hasAccount(e.account));
  if (unknown) { try { await refreshIdentity({ store: deps.store, mailRoot }); } catch { /* best-effort */ } }
```

(Import `refreshIdentity` from `./enrich.ts` in `sync.ts`.)

In `cli.ts`:
- In `backfill`, after `backfill(...)`, call `await refreshIdentity({ store: d.store, mailRoot: root })`.
- In `watch`, after `startWatch`, call `refreshIdentity` once and on an interval (e.g. `setInterval(() => refreshIdentity({ store: d.store, mailRoot: root }).catch(() => {}), 300_000)`).
- Add a `migrate` command:

```ts
  } else if (cmd === "migrate") {
    const root = requireMailRoot();
    const d = deps();
    let n = 0;
    const paths = d.store.raw.prepare("SELECT path FROM message_paths").all() as { path: string }[];
    for (const { path } of paths) {
      const mid = d.store.getMessageIdByPath(path);
      const mailbox = (d.store.raw.prepare("SELECT mailbox FROM message_paths WHERE path=?").get(path) as { mailbox: string } | undefined)?.mailbox ?? "";
      const account = (d.store.getMessage(mid ?? "")?.account) ?? path.slice(root.length + 1).split("/")[0];
      const { statSync } = await import("node:fs");
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
      if (await ingestEmlxFile(d, { path, account, mailbox, isPartial: path.endsWith(".partial.emlx"), mtimeMs })) n++;
    }
    const ident = await refreshIdentity({ store: d.store, mailRoot: root });
    console.log(`migrate: re-ingested ${n}, accounts ${ident.accounts}, roles ${ident.roles}`);
    d.store.close();
  }
```

Import `ingestEmlxFile` and `refreshIdentity` in `cli.ts`. Update the usage string to include `migrate`.

Add roles/accounts counts to `status` (optional but useful):

```ts
    const accts = d.store.raw.prepare("SELECT COUNT(*) c FROM accounts").get() as { c: number };
    const roles = d.store.raw.prepare("SELECT COUNT(*) c FROM mailbox_roles WHERE role IS NOT NULL").get() as { c: number };
    console.log(`accounts: ${accts.c}, classified mailboxes: ${roles.c}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/enrich.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite + typecheck, then commit**

Run: `cd apps/mail-mirror && npm test && npm run typecheck`
Expected: all green, no type errors.

```bash
git add apps/mail-mirror/src/enrich.ts apps/mail-mirror/src/sync.ts apps/mail-mirror/src/cli.ts apps/mail-mirror/test/enrich.test.ts
git commit -m "feat(mirror): refresh accounts+roles in backfill/watch/reconcile + migrate cmd"
```

---

### Task 10: Optional AI role classifier (config-gated, injected)

**Files:**
- Create: `apps/mail-mirror/src/role-classify.ts`
- Modify: `apps/mail-mirror/src/cli.ts` (wire the classifier into `refreshIdentity` calls when configured)
- Test: `apps/mail-mirror/test/role-classify.test.ts` (create)

**Interfaces:**
- Consumes: `Role` (Task 7).
- Produces: `role-classify.ts`: `loadRoleClassifier(env = process.env): ((name: string) => Promise<Role | null>) | undefined` — returns a classifier only when `MAIL_CLASSIFY_ENDPOINT` (+ optional `MAIL_CLASSIFY_MODEL`, `MAIL_CLASSIFY_API_KEY`) is set; otherwise `undefined`. The classifier POSTs an OpenAI-compatible chat completion asking for exactly one role keyword or `none`, maps the reply to a `Role`, returns `null` for anything unrecognised.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mirror/test/role-classify.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRoleClassifier } from "../src/role-classify.ts";

test("classifier maps a valid reply to a role and 'none' to null", async () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "junk" } }] }) }) as any;
  const c = makeRoleClassifier({ endpoint: "http://x/v1/chat/completions", model: "m" }, fetchStub);
  assert.equal(await c("Quarantena"), "junk");

  const noneStub = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "none" } }] }) }) as any;
  const c2 = makeRoleClassifier({ endpoint: "http://x/v1/chat/completions", model: "m" }, noneStub);
  assert.equal(await c2("Weird Folder"), null);
});

test("classifier returns null on a fetch error", async () => {
  const c = makeRoleClassifier({ endpoint: "http://x", model: "m" }, async () => { throw new Error("down"); });
  assert.equal(await c("x"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && node --import tsx --test test/role-classify.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`role-classify.ts`:

```ts
import type { Role } from "./mailbox-roles.ts";

const ROLES: Role[] = ["inbox", "drafts", "sent", "trash", "junk", "archive", "important", "flagged"];

export interface ClassifyConfig { endpoint: string; model: string; apiKey?: string }

/** Build a best-effort mailbox-name→role classifier over an OpenAI-compatible chat endpoint. */
export function makeRoleClassifier(cfg: ClassifyConfig, fetchImpl: typeof fetch = fetch): (name: string) => Promise<Role | null> {
  return async (name: string) => {
    try {
      const res = await fetchImpl(cfg.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: "system", content: `Classify an email mailbox/folder name into exactly one of: ${ROLES.join(", ")}, or "none". Reply with only the single word.` },
            { role: "user", content: name },
          ],
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const word = (data.choices?.[0]?.message?.content ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
      return (ROLES as string[]).includes(word) ? (word as Role) : null;
    } catch {
      return null;
    }
  };
}

export function loadRoleClassifier(env: NodeJS.ProcessEnv = process.env): ((name: string) => Promise<Role | null>) | undefined {
  const endpoint = env.MAIL_CLASSIFY_ENDPOINT;
  if (!endpoint) return undefined;
  return makeRoleClassifier({ endpoint, model: env.MAIL_CLASSIFY_MODEL ?? "gpt-4o-mini", apiKey: env.MAIL_CLASSIFY_API_KEY });
}
```

In `cli.ts`, build the classifier once (`const classifyRole = loadRoleClassifier();`) and pass it into every `refreshIdentity({ ..., classifyRole })` call. Import `loadRoleClassifier`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && node --import tsx --test test/role-classify.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + full suite, then commit**

Run: `cd apps/mail-mirror && npm run typecheck && npm test`
Expected: green.

```bash
git add apps/mail-mirror/src/role-classify.ts apps/mail-mirror/src/cli.ts apps/mail-mirror/test/role-classify.test.ts
git commit -m "feat(mirror): optional AI mailbox-role classifier (config-gated)"
```

---

## Self-Review

**Spec coverage:**
- A1 accounts table → Task 6 + Task 9. ✅
- A2 flags/plist → Task 2 (+ persisted Task 4, wired Task 5). ✅
- A3 recipient/cc names → Task 3 (+ persisted Task 4, wired Task 5). ✅
- A4 trigram index → Tasks 1 (schema) + 4 (reindex/searchTrig). ✅
- A5 migration + mtime freshness → Task 1 (auto-migrate), Task 8 (mtime), Task 9 (`migrate` CLI). ✅
- A6 mailbox roles (SPECIAL-USE → AI → localized) → Task 7 (ladder) + Task 9 (localized-terms wiring) + Task 10 (AI). ✅
- Decision #2 `apple_thrid` stored → Task 2/4. ✅
- Dynamic refresh in backfill/watch/reconcile → Task 9. ✅

**Placeholder scan:** No TBD/TODO; the only narrative seam (Task 9 test note) gives the exact stub to inject. Fixed by instruction. ✅

**Type consistency:** `MessageRow` new fields defined in Task 4 and used in Task 5; `Role` defined in Task 7 and consumed in Tasks 9/10; `ParsedMessage` fields added in Tasks 2/3 and read in Task 5; `recordPath` optional `mtimeMs` added in Task 8 keeps Task 5's earlier call valid. `refreshIdentity` signature consistent across Tasks 9/10. ✅

**Note on Plan B:** Plan B (mail-mcp advanced search surface) consumes this plan's concrete columns/methods (`unread`/`flagged`/`answered`/`junk`, `to_names`/`cc_names`, `searchTrig`, `accountByEmailOrName`, `mailboxesForRole`, `apple_thrid`). It is authored as a separate plan after Plan A lands so its task code references the final shapes.
