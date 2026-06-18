# Mail Mirror & Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/mail-mirror`, a local SQLite mirror of Apple Mail (FTS5 search, content-addressed attachments, dedup by Message-ID, thread reconstruction), populated from on-disk `.emlx` files with an AppleScript fallback, kept live via FSEvents + nightly reconcile.

**Architecture:** A new TypeScript npm-workspace under `apps/`. Pure, single-responsibility modules (`emlx` parser, `blobstore`, `store`, `threads`, `locator`, `applescript-fallback`) composed by a `sync` engine and a `watch` loop, exposed through a `cli`. The mirror is the only writer; SQLite runs in WAL so mail-mcp (sub-project 2) can read concurrently. Reuses `apps/mail-mcp` AppleScript modules for the fallback.

**Tech Stack:** Node 24 + TypeScript (ESM), `better-sqlite3` (FTS5+WAL), `mailparser`, `chokidar` (FSEvents). Tests: `node --import tsx --test`.

Spec: `docs/superpowers/specs/2026-06-18-mail-mirror-store-design.md` (read it; the spike-validation section lists proven facts).

## Global Constraints

- Node + TypeScript, ESM (`"type": "module"`), npm workspace under `apps/mail-mirror`.
- Dependencies limited to: `better-sqlite3`, `mailparser`, `chokidar` (runtime); `tsx`, `typescript`, `@types/node`, `@types/better-sqlite3` (dev). No others without justification.
- Reuse over reimplement (very important): the AppleScript fallback imports from `apps/mail-mcp/src/applescript.ts` and `osascript.ts`; do NOT duplicate them. `apps/mail-mcp` must stay at that path.
- `.emlx` format: first line is the UTF-8 **byte count** (may have trailing spaces), then the RFC822 message, then a plist trailer. **Slice by bytes**, never by characters.
- Message-IDs are normalised everywhere: trim, strip surrounding `<` `>`. The normalised Message-ID is the dedup key.
- Mail store root: discover via glob `~/Library/Mail/V*` (do NOT hardcode `V10`).
- SQLite: WAL mode; the mirror is the only writer.
- Tests: `node --import tsx --test "test/**/*.test.ts"`; pure units where possible; integration uses a fake store directory in a tempdir (no Full Disk Access in CI).
- Store location: `~/Library/Application Support/mail-mirror/` (override `MAIL_MIRROR_DIR`); dir mode `0700`; contains `mail.db` and `blobs/`.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; avoid apostrophes in heredoc commit bodies.

## File Structure

- `apps/mail-mirror/package.json` — workspace manifest.
- `apps/mail-mirror/tsconfig.json` — TS config.
- `apps/mail-mirror/src/types.ts` — shared types (`ParsedMessage`, `ParsedAttachment`, `EmlxEntry`).
- `apps/mail-mirror/src/emlx.ts` — `.emlx` parsing (byte-count slice + mailparser).
- `apps/mail-mirror/src/blobstore.ts` — content-addressed attachment storage.
- `apps/mail-mirror/src/store.ts` — SQLite schema, open, upsert, FTS, attachments, queries.
- `apps/mail-mirror/src/threads.ts` — union-find thread assignment + thread metadata.
- `apps/mail-mirror/src/locator.ts` — find Mail root, enumerate `.emlx`, FDA detection.
- `apps/mail-mirror/src/applescript-fallback.ts` — fill bodies via mail-mcp AppleScript.
- `apps/mail-mirror/src/sync.ts` — `ingestEmlxFile`, `backfill`, `reconcile`.
- `apps/mail-mirror/src/watch.ts` — chokidar watcher.
- `apps/mail-mirror/src/cli.ts` — `backfill` / `watch` / `reconcile` / `status`.
- `apps/mail-mirror/launchagent/com.llmwiki.mailmirror.plist` — LaunchAgent template.
- `apps/mail-mirror/README.md` — setup (FDA, LaunchAgent install).
- `apps/mail-mirror/test/*.test.ts` — tests.
- `apps/mail-mirror/test/fixtures/` — sample `.emlx` fixtures + fake store tree.

Note on `account`: the on-disk path gives the account **UUID** dir and the `.mbox` name. Task code stores `account` = account-UUID dir name and `mailbox` = `.mbox` base name. Mapping UUID → friendly account name is deferred to sub-project 2 (which has AppleScript `list_mailboxes`).

---

### Task 1: Workspace scaffold + types + SQLite/FTS5 smoke test

**Files:**
- Create: `apps/mail-mirror/package.json`
- Create: `apps/mail-mirror/tsconfig.json`
- Create: `apps/mail-mirror/src/types.ts`
- Test: `apps/mail-mirror/test/smoke.test.ts`
- Modify: root `package.json` (add `apps/mail-mirror` to `workspaces` if the array does not already glob `apps/*`)

**Interfaces:**
- Produces: `ParsedAttachment`, `ParsedMessage`, `EmlxEntry` (types consumed by every later task).

- [ ] **Step 1: Create the workspace manifest**

`apps/mail-mirror/package.json`:
```json
{
  "name": "@llm-wiki/mail-mirror",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "mail-mirror": "src/cli.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "chokidar": "^4.0.0",
    "mailparser": "^3.7.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create tsconfig**

`apps/mail-mirror/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create shared types**

`apps/mail-mirror/src/types.ts`:
```ts
export interface ParsedAttachment {
  filename: string;
  mime: string;
  size: number;
  content: Buffer;
}

export interface ParsedMessage {
  messageId: string; // normalised, no angle brackets; "" if the header was absent
  fromName: string;
  fromAddr: string;
  to: string[];
  cc: string[];
  subject: string;
  date: number; // epoch seconds
  bodyText: string;
  inReplyTo: string | null; // normalised
  references: string[]; // normalised
  gmThrid: string | null;
  attachments: ParsedAttachment[];
}

/** One on-disk message file discovered by the locator. */
export interface EmlxEntry {
  path: string;
  account: string; // account-UUID dir name
  mailbox: string; // .mbox base name
  isPartial: boolean; // *.partial.emlx
  mtimeMs: number;
}
```

- [ ] **Step 4: Write the smoke test**

`apps/mail-mirror/test/smoke.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";

test("better-sqlite3 opens with WAL and FTS5 is available", () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
  db.prepare("INSERT INTO t(body) VALUES (?)").run("frecciarossa roma milano");
  const row = db.prepare("SELECT body FROM t WHERE t MATCH ?").get("roma") as { body: string };
  assert.ok(row.body.includes("frecciarossa"));
  db.close();
});
```

- [ ] **Step 5: Install deps and run the smoke test**

Run: `cd apps/mail-mirror && npm install && npm test`
Expected: install succeeds (native `better-sqlite3` build), test PASS (1 test). If the root `package.json` `workspaces` already globs `apps/*`, `npm install` from the repo root also works.

- [ ] **Step 6: Commit**

```bash
git add apps/mail-mirror/package.json apps/mail-mirror/tsconfig.json apps/mail-mirror/src/types.ts apps/mail-mirror/test/smoke.test.ts package.json package-lock.json
git commit -m "feat(mail-mirror): scaffold workspace with sqlite/fts5 smoke test"
```

---

### Task 2: `.emlx` parser

**Files:**
- Create: `apps/mail-mirror/src/emlx.ts`
- Test: `apps/mail-mirror/test/emlx.test.ts`

**Interfaces:**
- Consumes: `ParsedMessage`, `ParsedAttachment` from `types.ts`.
- Produces:
  - `sliceMessageBytes(buf: Buffer): Buffer` — strip the leading byte-count line and the trailing plist, returning the RFC822 message bytes.
  - `normalizeId(raw: string | null | undefined): string | null` — trim + strip `<>`; `null` if empty.
  - `parseEmlx(buf: Buffer): Promise<ParsedMessage>` — full parse via `mailparser`.

- [ ] **Step 1: Write failing tests**

`apps/mail-mirror/test/emlx.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeId, parseEmlx, sliceMessageBytes } from "../src/emlx.ts";

function makeEmlx(rfc: string): Buffer {
  const plist = '<?xml version="1.0"?><plist><dict></dict></plist>\n';
  const body = Buffer.from(rfc, "utf8");
  const header = Buffer.from(String(body.length) + "    \n", "utf8");
  return Buffer.concat([header, body, Buffer.from(plist, "utf8")]);
}

const RFC =
  "From: CartaFreccia <noreply@trenitalia.it>\r\n" +
  "To: me@example.com\r\n" +
  "Subject: =?UTF-8?B?8J+nsyAtMjAl?=\r\n" +
  "Message-ID: <abc123@trenitalia.it>\r\n" +
  "In-Reply-To: <root99@trenitalia.it>\r\n" +
  "References: <root99@trenitalia.it> <mid50@trenitalia.it>\r\n" +
  "Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
  "--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCodice FRECCIA20.\r\n" +
  "--B\r\nContent-Type: application/pdf; name=p.pdf\r\n" +
  "Content-Disposition: attachment; filename=p.pdf\r\n" +
  "Content-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--B--\r\n";

test("normalizeId strips angle brackets and whitespace", () => {
  assert.equal(normalizeId("  <abc@x>  "), "abc@x");
  assert.equal(normalizeId(""), null);
  assert.equal(normalizeId(undefined), null);
});

test("sliceMessageBytes returns exactly the RFC822 message (by byte count)", () => {
  const emlx = makeEmlx(RFC);
  const msg = sliceMessageBytes(emlx).toString("utf8");
  assert.ok(msg.startsWith("From: CartaFreccia"));
  assert.ok(msg.trimEnd().endsWith("--B--"));
  assert.ok(!msg.includes("<plist>"));
});

test("parseEmlx extracts headers, body, threading, attachments", async () => {
  const m = await parseEmlx(makeEmlx(RFC));
  assert.equal(m.messageId, "abc123@trenitalia.it");
  assert.equal(m.fromAddr, "noreply@trenitalia.it");
  assert.ok(m.subject.includes("-20%"));
  assert.ok(m.bodyText.includes("FRECCIA20"));
  assert.equal(m.inReplyTo, "root99@trenitalia.it");
  assert.deepEqual(m.references, ["root99@trenitalia.it", "mid50@trenitalia.it"]);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, "p.pdf");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — `Cannot find module '../src/emlx.ts'`.

- [ ] **Step 3: Implement the parser**

`apps/mail-mirror/src/emlx.ts`:
```ts
import { readFile } from "node:fs/promises";
import { simpleParser } from "mailparser";
import type { ParsedAttachment, ParsedMessage } from "./types.ts";

export function normalizeId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/^<|>$/g, "").trim();
  return t.length ? t : null;
}

function normalizeRefs(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/\s+/);
  return list.map((r) => normalizeId(r)).filter((r): r is string => !!r);
}

/** Strip the leading byte-count line and the trailing plist; return the message bytes. */
export function sliceMessageBytes(buf: Buffer): Buffer {
  const nl = buf.indexOf(0x0a); // first newline
  if (nl < 0) return buf;
  const count = parseInt(buf.subarray(0, nl).toString("ascii"), 10);
  if (Number.isFinite(count) && count > 0 && nl + 1 + count <= buf.length) {
    return buf.subarray(nl + 1, nl + 1 + count);
  }
  // Fallback: drop only the count line if the count looks wrong.
  return buf.subarray(nl + 1);
}

export async function parseEmlx(buf: Buffer): Promise<ParsedMessage> {
  const m = await simpleParser(sliceMessageBytes(buf));
  const fromAddr = m.from?.value?.[0]?.address ?? "";
  const fromName = m.from?.value?.[0]?.name ?? "";
  const toList = (m.to && !Array.isArray(m.to) ? m.to.value : []).map((a) => a.address ?? "").filter(Boolean);
  const ccList = (m.cc && !Array.isArray(m.cc) ? m.cc.value : []).map((a) => a.address ?? "").filter(Boolean);
  const bodyText = m.text ?? (m.html ? String(m.html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
  const attachments: ParsedAttachment[] = (m.attachments ?? []).map((a) => ({
    filename: a.filename ?? "attachment",
    mime: a.contentType ?? "application/octet-stream",
    size: a.size ?? a.content.length,
    content: a.content,
  }));
  const gm = m.headers.get("x-gm-thrid");
  return {
    messageId: normalizeId(m.messageId) ?? "",
    fromName,
    fromAddr,
    to: toList,
    cc: ccList,
    subject: m.subject ?? "",
    date: m.date ? Math.floor(m.date.getTime() / 1000) : 0,
    bodyText,
    inReplyTo: normalizeId(m.inReplyTo),
    references: normalizeRefs(m.references),
    gmThrid: gm ? String(gm) : null,
    attachments,
  };
}

export async function parseEmlxFile(path: string): Promise<ParsedMessage> {
  return parseEmlx(await readFile(path));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS (3 emlx tests + smoke).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/emlx.ts apps/mail-mirror/test/emlx.test.ts
git commit -m "feat(mail-mirror): emlx byte-count parser with mailparser"
```

---

### Task 3: Content-addressed attachment blobstore

**Files:**
- Create: `apps/mail-mirror/src/blobstore.ts`
- Test: `apps/mail-mirror/test/blobstore.test.ts`

**Interfaces:**
- Produces: `class BlobStore { constructor(rootDir: string); put(content: Buffer): { sha256: string; relPath: string }; absPath(relPath: string): string; }`
  - `put` writes `content` to `<rootDir>/<aa>/<sha256>` (sharded by first 2 hex chars); identical content yields the same path and is written once. `relPath` is relative to `rootDir`.

- [ ] **Step 1: Write failing test**

`apps/mail-mirror/test/blobstore.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../src/blobstore.ts";

test("put is content-addressed and idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "blob-"));
  const bs = new BlobStore(dir);
  const a = bs.put(Buffer.from("hello"));
  const b = bs.put(Buffer.from("hello"));
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.relPath, b.relPath);
  assert.ok(existsSync(bs.absPath(a.relPath)));
  assert.notEqual(a.sha256, bs.put(Buffer.from("world")).sha256);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find `../src/blobstore.ts`.

- [ ] **Step 3: Implement BlobStore**

`apps/mail-mirror/src/blobstore.ts`:
```ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export class BlobStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
  }

  put(content: Buffer): { sha256: string; relPath: string } {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const relPath = join(sha256.slice(0, 2), sha256);
    const abs = this.absPath(relPath);
    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    return { sha256, relPath };
  }

  absPath(relPath: string): string {
    return join(this.rootDir, relPath);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/blobstore.ts apps/mail-mirror/test/blobstore.test.ts
git commit -m "feat(mail-mirror): content-addressed attachment blobstore"
```

---

### Task 4: SQLite store (schema, upsert, FTS, attachments, queries)

**Files:**
- Create: `apps/mail-mirror/src/store.ts`
- Test: `apps/mail-mirror/test/store.test.ts`

**Interfaces:**
- Consumes: `ParsedMessage` from `types.ts`.
- Produces:
  - `type BodyState = "full" | "partial" | "none"`
  - `interface MessageRow { messageId: string; account: string; mailbox: string; fromName: string; fromAddr: string; to: string[]; cc: string[]; subject: string; date: number; bodyText: string; bodyState: BodyState; source: "emlx" | "applescript"; emlxPath: string | null; inReplyTo: string | null; references: string[]; gmThrid: string | null; size: number; }`
  - `class Store { constructor(db: Database.Database); static open(path: string): Store; upsertMessage(row: MessageRow): void; insertAttachments(messageId: string, atts: { filename: string; mime: string; size: number; sha256: string; relPath: string; downloaded: boolean }[]): void; setThreadId(messageId: string, threadId: number): void; getMessage(messageId: string): MessageRow | undefined; searchFts(query: string, limit: number): MessageRow[]; softDelete(messageId: string): void; getState(key: string): string | undefined; setState(key: string, value: string): void; allMessageIdsByPath(): Map<string, string>; close(): void; raw: Database.Database; }`

- [ ] **Step 1: Write failing tests**

`apps/mail-mirror/test/store.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    messageId: "m1@x",
    account: "ACC", mailbox: "INBOX",
    fromName: "Trenitalia", fromAddr: "noreply@trenitalia.it",
    to: ["me@x"], cc: [],
    subject: "Sconto -20% viaggi", date: 1750000000,
    bodyText: "Frecciarossa Roma Milano FRECCIA20",
    bodyState: "full", source: "emlx", emlxPath: "/p/1.emlx",
    inReplyTo: null, references: [], gmThrid: null, size: 100,
    ...overrides,
  };
}

test("upsert dedups by messageId and FTS finds body terms", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  s.upsertMessage(row({ subject: "Sconto -20% viaggi (updated)" })); // same id -> update
  const hits = s.searchFts("frecciarossa", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1@x");
  assert.ok(hits[0].subject.includes("updated"));
  s.close();
});

test("attachments and soft delete", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  s.insertAttachments("m1@x", [{ filename: "p.pdf", mime: "application/pdf", size: 5, sha256: "abcd", relPath: "ab/abcd", downloaded: true }]);
  s.softDelete("m1@x");
  const got = s.getMessage("m1@x");
  assert.ok(got); // row remains (soft delete)
  const raw = s.raw.prepare("SELECT deleted FROM messages WHERE message_id=?").get("m1@x") as { deleted: number };
  assert.equal(raw.deleted, 1);
  s.close();
});

test("state get/set round-trips", () => {
  const s = Store.open(":memory:");
  s.setState("backfill.cursor", "42");
  assert.equal(s.getState("backfill.cursor"), "42");
  assert.equal(s.getState("missing"), undefined);
  s.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find `../src/store.ts`.

- [ ] **Step 3: Implement the store**

`apps/mail-mirror/src/store.ts`:
```ts
import Database from "better-sqlite3";
import type { ParsedMessage } from "./types.ts";

export type BodyState = "full" | "partial" | "none";

export interface MessageRow {
  messageId: string;
  account: string;
  mailbox: string;
  fromName: string;
  fromAddr: string;
  to: string[];
  cc: string[];
  subject: string;
  date: number;
  bodyText: string;
  bodyState: BodyState;
  source: "emlx" | "applescript";
  emlxPath: string | null;
  inReplyTo: string | null;
  references: string[];
  gmThrid: string | null;
  size: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY, account TEXT NOT NULL, mailbox TEXT,
  from_name TEXT, from_addr TEXT, to_addrs TEXT, cc_addrs TEXT,
  subject TEXT, date INTEGER, snippet TEXT, body_text TEXT,
  body_state TEXT NOT NULL, source TEXT NOT NULL, emlx_path TEXT,
  in_reply_to TEXT, reference_ids TEXT, gm_thrid TEXT, thread_id INTEGER,
  flagged INTEGER DEFAULT 0, unread INTEGER DEFAULT 0, size INTEGER,
  deleted INTEGER DEFAULT 0, ingested_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_account_date ON messages(account, date);
CREATE INDEX IF NOT EXISTS idx_messages_emlx_path ON messages(emlx_path);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, from_addr, from_name, to_addrs, body_text,
  content='messages', content_rowid='rowid'
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, mime TEXT,
  size INTEGER, sha256 TEXT NOT NULL, blob_path TEXT, downloaded INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_att_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_att_sha ON attachments(sha256);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY, subject TEXT, participants TEXT,
  first_date INTEGER, last_date INTEGER, msg_count INTEGER
);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
`;

export class Store {
  raw: Database.Database;

  constructor(db: Database.Database) {
    this.raw = db;
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
  }

  static open(path: string): Store {
    return new Store(new Database(path));
  }

  upsertMessage(r: MessageRow): void {
    const snippet = r.bodyText.slice(0, 200);
    const now = Math.floor(Date.now() / 1000);
    this.raw
      .prepare(
        `INSERT INTO messages (message_id, account, mailbox, from_name, from_addr, to_addrs, cc_addrs,
           subject, date, snippet, body_text, body_state, source, emlx_path, in_reply_to, reference_ids,
           gm_thrid, size, deleted, ingested_at, updated_at)
         VALUES (@message_id,@account,@mailbox,@from_name,@from_addr,@to_addrs,@cc_addrs,
           @subject,@date,@snippet,@body_text,@body_state,@source,@emlx_path,@in_reply_to,@reference_ids,
           @gm_thrid,@size,0,@now,@now)
         ON CONFLICT(message_id) DO UPDATE SET
           account=excluded.account, mailbox=excluded.mailbox, from_name=excluded.from_name,
           from_addr=excluded.from_addr, to_addrs=excluded.to_addrs, cc_addrs=excluded.cc_addrs,
           subject=excluded.subject, date=excluded.date, snippet=excluded.snippet,
           body_text=excluded.body_text, body_state=excluded.body_state, source=excluded.source,
           emlx_path=excluded.emlx_path, in_reply_to=excluded.in_reply_to,
           reference_ids=excluded.reference_ids, gm_thrid=excluded.gm_thrid, size=excluded.size,
           deleted=0, updated_at=@now`,
      )
      .run({
        message_id: r.messageId, account: r.account, mailbox: r.mailbox,
        from_name: r.fromName, from_addr: r.fromAddr,
        to_addrs: JSON.stringify(r.to), cc_addrs: JSON.stringify(r.cc),
        subject: r.subject, date: r.date, snippet, body_text: r.bodyText,
        body_state: r.bodyState, source: r.source, emlx_path: r.emlxPath,
        in_reply_to: r.inReplyTo, reference_ids: JSON.stringify(r.references),
        gm_thrid: r.gmThrid, size: r.size, now,
      });
    this.reindexFts(r.messageId);
  }

  private reindexFts(messageId: string): void {
    const m = this.raw.prepare("SELECT rowid, subject, from_addr, from_name, to_addrs, body_text FROM messages WHERE message_id=?").get(messageId) as
      | { rowid: number; subject: string; from_addr: string; from_name: string; to_addrs: string; body_text: string }
      | undefined;
    if (!m) return;
    this.raw.prepare("INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', ?)").run(m.rowid);
    this.raw
      .prepare("INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addrs, body_text) VALUES (?,?,?,?,?,?)")
      .run(m.rowid, m.subject, m.from_addr, m.from_name, m.to_addrs, m.body_text);
  }

  insertAttachments(messageId: string, atts: { filename: string; mime: string; size: number; sha256: string; relPath: string; downloaded: boolean }[]): void {
    this.raw.prepare("DELETE FROM attachments WHERE message_id=?").run(messageId);
    const ins = this.raw.prepare("INSERT INTO attachments (message_id, filename, mime, size, sha256, blob_path, downloaded) VALUES (?,?,?,?,?,?,?)");
    for (const a of atts) ins.run(messageId, a.filename, a.mime, a.size, a.sha256, a.relPath, a.downloaded ? 1 : 0);
  }

  setThreadId(messageId: string, threadId: number): void {
    this.raw.prepare("UPDATE messages SET thread_id=? WHERE message_id=?").run(threadId, messageId);
  }

  getMessage(messageId: string): MessageRow | undefined {
    const m = this.raw.prepare("SELECT * FROM messages WHERE message_id=?").get(messageId) as Record<string, unknown> | undefined;
    return m ? rowToMessage(m) : undefined;
  }

  searchFts(query: string, limit: number): MessageRow[] {
    const rows = this.raw
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
         WHERE messages_fts MATCH ? AND m.deleted=0 ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  softDelete(messageId: string): void {
    this.raw.prepare("UPDATE messages SET deleted=1, updated_at=? WHERE message_id=?").run(Math.floor(Date.now() / 1000), messageId);
  }

  allMessageIdsByPath(): Map<string, string> {
    const rows = this.raw.prepare("SELECT message_id, emlx_path FROM messages WHERE emlx_path IS NOT NULL AND deleted=0").all() as { message_id: string; emlx_path: string }[];
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.emlx_path, r.message_id);
    return map;
  }

  getState(key: string): string | undefined {
    const r = this.raw.prepare("SELECT value FROM sync_state WHERE key=?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setState(key: string, value: string): void {
    this.raw.prepare("INSERT INTO sync_state(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  close(): void {
    this.raw.close();
  }
}

function rowToMessage(m: Record<string, unknown>): MessageRow {
  return {
    messageId: m.message_id as string,
    account: m.account as string,
    mailbox: (m.mailbox as string) ?? "",
    fromName: (m.from_name as string) ?? "",
    fromAddr: (m.from_addr as string) ?? "",
    to: JSON.parse((m.to_addrs as string) || "[]"),
    cc: JSON.parse((m.cc_addrs as string) || "[]"),
    subject: (m.subject as string) ?? "",
    date: (m.date as number) ?? 0,
    bodyText: (m.body_text as string) ?? "",
    bodyState: (m.body_state as BodyState) ?? "none",
    source: (m.source as "emlx" | "applescript") ?? "emlx",
    emlxPath: (m.emlx_path as string) ?? null,
    inReplyTo: (m.in_reply_to as string) ?? null,
    references: JSON.parse((m.reference_ids as string) || "[]"),
    gmThrid: (m.gm_thrid as string) ?? null,
    size: (m.size as number) ?? 0,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS (store tests + earlier).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/store.ts apps/mail-mirror/test/store.test.ts
git commit -m "feat(mail-mirror): sqlite store with FTS5, upsert dedup, soft delete"
```

---

### Task 5: Thread reconstruction (union-find)

**Files:**
- Create: `apps/mail-mirror/src/threads.ts`
- Test: `apps/mail-mirror/test/threads.test.ts`

**Interfaces:**
- Produces:
  - `class ThreadIndex { union(ids: string[]): void; rootOf(id: string): string; groups(): Map<string, string[]>; }` — pure in-memory union-find over Message-IDs.
  - `normalizeSubject(s: string): string` — strip `Re:/Fwd:/R:/AW:/I:`/`Fw:` prefixes (case-insensitive, repeated), trim.

  The store-integrated `thread_id` assignment (mapping a union-find root to a stable surrogate integer in the `threads` table) is wired in Task 7 using these primitives.

- [ ] **Step 1: Write failing tests**

`apps/mail-mirror/test/threads.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadIndex, normalizeSubject } from "../src/threads.ts";

test("union-find groups messages sharing references, merging via a bridge", () => {
  const ti = new ThreadIndex();
  ti.union(["a"]);            // lone message a
  ti.union(["b", "c"]);       // c references b
  ti.union(["d", "b"]);       // d references b -> {b,c,d}
  ti.union(["e", "a", "c"]);  // e bridges a and c -> everything except none
  const root = ti.rootOf("a");
  for (const id of ["a", "b", "c", "d", "e"]) assert.equal(ti.rootOf(id), root);
});

test("normalizeSubject strips reply/forward prefixes repeatedly", () => {
  assert.equal(normalizeSubject("Re: Fwd:  R: Offerta"), "Offerta");
  assert.equal(normalizeSubject("I: Protiviti"), "Protiviti");
  assert.equal(normalizeSubject("Plain"), "Plain");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find `../src/threads.ts`.

- [ ] **Step 3: Implement**

`apps/mail-mirror/src/threads.ts`:
```ts
export class ThreadIndex {
  private parent = new Map<string, string>();

  private find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(ids: string[]): void {
    const present = ids.filter((i) => i && i.length);
    if (present.length === 0) return;
    const first = this.find(present[0]);
    for (const id of present.slice(1)) {
      this.parent.set(this.find(id), first);
    }
  }

  rootOf(id: string): string {
    return this.find(id);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const r = this.find(id);
      const arr = out.get(r) ?? [];
      arr.push(id);
      out.set(r, arr);
    }
    return out;
  }
}

const PREFIX_RE = /^\s*(re|fwd|fw|r|aw|i)\s*:\s*/i;

export function normalizeSubject(s: string): string {
  let out = s ?? "";
  let prev;
  do {
    prev = out;
    out = out.replace(PREFIX_RE, "");
  } while (out !== prev);
  return out.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/threads.ts apps/mail-mirror/test/threads.test.ts
git commit -m "feat(mail-mirror): union-find thread index + subject normalisation"
```

---

### Task 6: Store locator + Full Disk Access detection

**Files:**
- Create: `apps/mail-mirror/src/locator.ts`
- Test: `apps/mail-mirror/test/locator.test.ts`
- Test fixtures: created in-test under a tempdir (no real Mail store needed).

**Interfaces:**
- Consumes: `EmlxEntry` from `types.ts`.
- Produces:
  - `findMailRoot(home?: string): string | null` — returns the highest `~/Library/Mail/V*` dir, or `null` if none.
  - `canRead(dir: string): boolean` — `false` on `EPERM`/`EACCES` (Full Disk Access missing).
  - `enumerateEmlx(mailRoot: string): EmlxEntry[]` — walk `*.emlx`/`*.partial.emlx`, deriving `account` (UUID dir under the version root) and `mailbox` (`.mbox` base name).

- [ ] **Step 1: Write failing test**

`apps/mail-mirror/test/locator.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMailRoot, canRead, enumerateEmlx } from "../src/locator.ts";

function fakeStore(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const root = join(home, "Library", "Mail", "V10");
  const msgs = join(root, "ACC-UUID", "INBOX.mbox", "BOX-UUID", "Data", "Messages");
  mkdirSync(msgs, { recursive: true });
  writeFileSync(join(msgs, "1.emlx"), "10\nfull-msg-1");
  writeFileSync(join(msgs, "2.partial.emlx"), "5\nstub2");
  return { home, root };
}

test("findMailRoot picks the V* dir; canRead true for readable", () => {
  const { home, root } = fakeStore();
  assert.equal(findMailRoot(home), root);
  assert.equal(canRead(root), true);
});

test("enumerateEmlx yields account, mailbox, isPartial", () => {
  const { root } = fakeStore();
  const entries = enumerateEmlx(root).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].account, "ACC-UUID");
  assert.equal(entries[0].mailbox, "INBOX");
  assert.equal(entries.find((e) => e.path.endsWith("2.partial.emlx"))!.isPartial, true);
  assert.equal(entries.find((e) => e.path.endsWith("1.emlx"))!.isPartial, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find `../src/locator.ts`.

- [ ] **Step 3: Implement**

`apps/mail-mirror/src/locator.ts`:
```ts
import { readdirSync, statSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { EmlxEntry } from "./types.ts";

export function findMailRoot(home: string = homedir()): string | null {
  const mailDir = join(home, "Library", "Mail");
  let versions: string[];
  try {
    versions = readdirSync(mailDir).filter((d) => /^V\d+$/.test(d));
  } catch {
    return null;
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10));
  return join(mailDir, versions[0]);
}

export function canRead(dir: string): boolean {
  try {
    accessSync(dir, constants.R_OK);
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

export function enumerateEmlx(mailRoot: string): EmlxEntry[] {
  const out: EmlxEntry[] = [];
  walk(mailRoot, mailRoot, out);
  return out;
}

function accountAndMailbox(mailRoot: string, filePath: string): { account: string; mailbox: string } {
  const rel = filePath.slice(mailRoot.length + 1);
  const parts = rel.split("/");
  const account = parts[0] ?? "";
  const mboxPart = parts.find((p) => p.endsWith(".mbox")) ?? "";
  return { account, mailbox: mboxPart.replace(/\.mbox$/, "") };
}

function walk(mailRoot: string, dir: string, out: EmlxEntry[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(mailRoot, full, out);
    } else if (name.endsWith(".emlx")) {
      const { account, mailbox } = accountAndMailbox(mailRoot, full);
      out.push({ path: full, account, mailbox, isPartial: name.endsWith(".partial.emlx"), mtimeMs: st.mtimeMs });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/locator.ts apps/mail-mirror/test/locator.test.ts
git commit -m "feat(mail-mirror): store locator and FDA detection"
```

---

### Task 7: Ingest pipeline (parse -> store -> attachments -> thread)

**Files:**
- Create: `apps/mail-mirror/src/sync.ts`
- Test: `apps/mail-mirror/test/sync.ingest.test.ts`

**Interfaces:**
- Consumes: `parseEmlxFile` (Task 2), `Store`/`MessageRow`/`BodyState` (Task 4), `BlobStore` (Task 3), `EmlxEntry` (Task 1), `normalizeSubject` (Task 5).
- Produces:
  - `interface SyncDeps { store: Store; blobs: BlobStore; }`
  - `bodyStateFor(isPartial: boolean, bodyText: string): BodyState` — `none` if partial+empty, `partial` if partial, else `full`.
  - `async ingestEmlxFile(deps: SyncDeps, entry: EmlxEntry): Promise<string | null>` — parse, upsert message (dedup by Message-ID), store attachments to blobstore, assign `thread_id`. Returns the Message-ID (or `null` if unparseable). Thread assignment: resolve a surrogate `thread_id` by unioning the message's own id with `inReplyTo`/`references` over the `threads`+`messages` tables; if none link, reuse an existing thread that shares `normalizeSubject(subject)` + a participant within 14 days, else create a new thread.

- [ ] **Step 1: Write failing test**

`apps/mail-mirror/test/sync.ingest.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { ingestEmlxFile, bodyStateFor } from "../src/sync.ts";
import type { EmlxEntry } from "../src/types.ts";

function emlx(dir: string, name: string, rfc: string): string {
  const body = Buffer.from(rfc, "utf8");
  const buf = Buffer.concat([Buffer.from(String(body.length) + "\n"), body, Buffer.from("<plist></plist>\n")]);
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

const ROOT = (mid: string, extra = "") =>
  `From: A <a@x>\r\nTo: me@x\r\nSubject: Hello\r\nMessage-ID: <${mid}>\r\n${extra}Content-Type: text/plain\r\n\r\nbody ${mid}\r\n`;

test("bodyStateFor classifies", () => {
  assert.equal(bodyStateFor(false, "x"), "full");
  assert.equal(bodyStateFor(true, "x"), "partial");
  assert.equal(bodyStateFor(true, ""), "none");
});

test("ingest stores message and groups a reply into the same thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ing-"));
  const store = Store.open(":memory:");
  const blobs = new BlobStore(join(dir, "blobs"));
  const deps = { store, blobs };

  const e1: EmlxEntry = { path: emlx(dir, "1.emlx", ROOT("root@x")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 };
  const e2: EmlxEntry = { path: emlx(dir, "2.emlx", ROOT("reply@x", "In-Reply-To: <root@x>\r\nReferences: <root@x>\r\n")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 2 };

  const id1 = await ingestEmlxFile(deps, e1);
  const id2 = await ingestEmlxFile(deps, e2);
  assert.equal(id1, "root@x");
  assert.equal(id2, "reply@x");

  const t1 = store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("root@x") as { thread_id: number };
  const t2 = store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("reply@x") as { thread_id: number };
  assert.ok(t1.thread_id != null && t1.thread_id === t2.thread_id);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find `../src/sync.ts`.

- [ ] **Step 3: Implement ingest (+ private thread resolver)**

`apps/mail-mirror/src/sync.ts`:
```ts
import { parseEmlxFile } from "./emlx.ts";
import { normalizeSubject } from "./threads.ts";
import type { BlobStore } from "./blobstore.ts";
import type { BodyState, MessageRow, Store } from "./store.ts";
import type { EmlxEntry, ParsedMessage } from "./types.ts";

export interface SyncDeps {
  store: Store;
  blobs: BlobStore;
}

export function bodyStateFor(isPartial: boolean, bodyText: string): BodyState {
  if (!isPartial) return "full";
  return bodyText.trim().length > 0 ? "partial" : "none";
}

/** Resolve (and persist) a surrogate thread_id for a message, before it is upserted. */
function resolveThreadId(store: Store, m: ParsedMessage): number {
  const db = store.raw;
  const linkedIds = [m.inReplyTo, ...m.references].filter((x): x is string => !!x);
  // 1) Any already-stored linked message shares its thread.
  for (const id of linkedIds) {
    const row = db.prepare("SELECT thread_id FROM messages WHERE message_id=? AND thread_id IS NOT NULL").get(id) as { thread_id: number } | undefined;
    if (row?.thread_id != null) return row.thread_id;
  }
  // 2) Subject + participant + 14-day fallback.
  const subj = normalizeSubject(m.subject);
  if (subj) {
    const since = m.date - 14 * 86400;
    const until = m.date + 14 * 86400;
    const cand = db
      .prepare("SELECT thread_id, from_addr, to_addrs FROM messages WHERE thread_id IS NOT NULL AND date BETWEEN ? AND ? AND subject LIKE ?")
      .all(since, until, "%" + subj + "%") as { thread_id: number; from_addr: string; to_addrs: string }[];
    const parts = new Set<string>([m.fromAddr, ...m.to]);
    for (const c of cand) {
      const cParts = new Set<string>([c.from_addr, ...JSON.parse(c.to_addrs || "[]")]);
      if ([...parts].some((p) => p && cParts.has(p))) return c.thread_id;
    }
  }
  // 3) New thread.
  const info = db.prepare("INSERT INTO threads(subject, participants, first_date, last_date, msg_count) VALUES (?,?,?,?,0)").run(subj, JSON.stringify([m.fromAddr, ...m.to]), m.date, m.date);
  return Number(info.lastInsertRowid);
}

function bumpThread(store: Store, threadId: number, date: number): void {
  store.raw
    .prepare("UPDATE threads SET msg_count=msg_count+1, first_date=MIN(first_date,?), last_date=MAX(last_date,?) WHERE id=?")
    .run(date, date, threadId);
}

export async function ingestEmlxFile(deps: SyncDeps, entry: EmlxEntry): Promise<string | null> {
  let parsed: ParsedMessage;
  try {
    parsed = await parseEmlxFile(entry.path);
  } catch {
    return null; // malformed; caller may fall back to AppleScript
  }
  const messageId = parsed.messageId || `nomsgid:${entry.account}:${entry.path}`;
  const threadId = resolveThreadId(deps.store, { ...parsed, messageId });

  const row: MessageRow = {
    messageId,
    account: entry.account,
    mailbox: entry.mailbox,
    fromName: parsed.fromName,
    fromAddr: parsed.fromAddr,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    date: parsed.date,
    bodyText: parsed.bodyText,
    bodyState: bodyStateFor(entry.isPartial, parsed.bodyText),
    source: "emlx",
    emlxPath: entry.path,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    gmThrid: parsed.gmThrid,
    size: parsed.attachments.reduce((n, a) => n + a.size, parsed.bodyText.length),
  };
  deps.store.upsertMessage(row);
  deps.store.setThreadId(messageId, threadId);
  bumpThread(deps.store, threadId, parsed.date);

  const atts = parsed.attachments.map((a) => {
    const { sha256, relPath } = deps.blobs.put(a.content);
    return { filename: a.filename, mime: a.mime, size: a.size, sha256, relPath, downloaded: true };
  });
  if (atts.length) deps.store.insertAttachments(messageId, atts);
  return messageId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/sync.ts apps/mail-mirror/test/sync.ingest.test.ts
git commit -m "feat(mail-mirror): ingest pipeline with thread assignment"
```

---

### Task 8: Backfill (recent-first) + reconcile

**Files:**
- Modify: `apps/mail-mirror/src/sync.ts` (add `backfill`, `reconcile`)
- Test: `apps/mail-mirror/test/sync.backfill.test.ts`

**Interfaces:**
- Consumes: `enumerateEmlx` (Task 6), `ingestEmlxFile`/`SyncDeps` (Task 7), `Store` (Task 4).
- Produces:
  - `async backfill(deps: SyncDeps, mailRoot: string, opts?: { recentMonths?: number }): Promise<{ ingested: number }>` — enumerate, sort by `mtimeMs` desc (recent-first), ingest each; records progress in `sync_state` (`backfill.last_path`, `backfill.ingested`).
  - `async reconcile(deps: SyncDeps, mailRoot: string): Promise<{ ingested: number; deleted: number }>` — ingest files not yet in the DB (by path) and soft-delete DB rows whose `emlx_path` no longer exists on disk.

- [ ] **Step 1: Write failing test**

`apps/mail-mirror/test/sync.backfill.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { backfill, reconcile } from "../src/sync.ts";

function store(root: string, acct: string, n: number, mid: string): string {
  const dir = join(root, acct, "INBOX.mbox", "B", "Data", "Messages");
  mkdirSync(dir, { recursive: true });
  const rfc = `From: A <a@x>\r\nSubject: S${n}\r\nMessage-ID: <${mid}>\r\nContent-Type: text/plain\r\n\r\nbody ${mid}\r\n`;
  const body = Buffer.from(rfc);
  const p = join(dir, `${n}.emlx`);
  writeFileSync(p, Buffer.concat([Buffer.from(String(body.length) + "\n"), body, Buffer.from("<plist></plist>\n")]));
  return p;
}

test("backfill ingests all; reconcile adds new and soft-deletes removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "root-"));
  const s = Store.open(":memory:");
  const deps = { store: s, blobs: new BlobStore(join(root, "blobs")) };
  const p1 = store(root, "ACC", 1, "a@x");
  store(root, "ACC", 2, "b@x");

  const bf = await backfill(deps, root);
  assert.equal(bf.ingested, 2);
  assert.ok(s.getMessage("a@x") && s.getMessage("b@x"));

  store(root, "ACC", 3, "c@x"); // new file
  rmSync(p1); // removed file
  const rc = await reconcile(deps, root);
  assert.equal(rc.ingested, 1); // c@x
  assert.equal(rc.deleted, 1); // a@x
  const a = s.raw.prepare("SELECT deleted FROM messages WHERE message_id=?").get("a@x") as { deleted: number };
  assert.equal(a.deleted, 1);
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — `backfill`/`reconcile` not exported.

- [ ] **Step 3: Implement (append to `src/sync.ts`)**

```ts
import { existsSync } from "node:fs";
import { enumerateEmlx } from "./locator.ts";

export async function backfill(deps: SyncDeps, mailRoot: string, opts: { recentMonths?: number } = {}): Promise<{ ingested: number }> {
  const entries = enumerateEmlx(mailRoot).sort((a, b) => b.mtimeMs - a.mtimeMs); // recent-first
  let ingested = 0;
  for (const e of entries) {
    const id = await ingestEmlxFile(deps, e);
    if (id) {
      ingested++;
      deps.store.setState("backfill.last_path", e.path);
      deps.store.setState("backfill.ingested", String(ingested));
    }
  }
  return { ingested };
}

export async function reconcile(deps: SyncDeps, mailRoot: string): Promise<{ ingested: number; deleted: number }> {
  const entries = enumerateEmlx(mailRoot);
  const onDisk = new Set(entries.map((e) => e.path));
  const known = deps.store.allMessageIdsByPath(); // path -> messageId
  let ingested = 0;
  for (const e of entries) {
    if (!known.has(e.path)) {
      const id = await ingestEmlxFile(deps, e);
      if (id) ingested++;
    }
  }
  let deleted = 0;
  for (const [path, messageId] of known) {
    if (!onDisk.has(path) && !existsSync(path)) {
      deps.store.softDelete(messageId);
      deleted++;
    }
  }
  return { ingested, deleted };
}
```

(Note: the `recentMonths` option is accepted for the CLI to prioritise; `mtime`-desc ordering already ingests recent messages first, so older history is reached last. The option is reserved for a future hard cap and is intentionally not yet used to filter.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/sync.ts apps/mail-mirror/test/sync.backfill.test.ts
git commit -m "feat(mail-mirror): recent-first backfill and reconcile"
```

---

### Task 9: FSEvents watcher

**Files:**
- Create: `apps/mail-mirror/src/watch.ts`
- Test: `apps/mail-mirror/test/watch.test.ts`

**Interfaces:**
- Consumes: `ingestEmlxFile`/`SyncDeps` (Task 7), `Store` (Task 4), `EmlxEntry` (Task 1).
- Produces:
  - `function entryForPath(mailRoot: string, path: string, mtimeMs: number): EmlxEntry` — build an `EmlxEntry` from a single path (reuses the locator's account/mailbox derivation; exported from `locator.ts` in this task).
  - `function startWatch(deps: SyncDeps, mailRoot: string): { close(): Promise<void> }` — chokidar watch; on `add`/`change` of `*.emlx` ingest; on `unlink` soft-delete the row whose `emlx_path` matches.

- [ ] **Step 1: Export `entryForPath` from the locator**

Add to `apps/mail-mirror/src/locator.ts`:
```ts
export function entryForPath(mailRoot: string, path: string, mtimeMs: number): import("./types.ts").EmlxEntry {
  const { account, mailbox } = accountAndMailbox(mailRoot, path);
  return { path, account, mailbox, isPartial: path.endsWith(".partial.emlx"), mtimeMs };
}
```

- [ ] **Step 2: Write failing test**

`apps/mail-mirror/test/watch.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { startWatch } from "../src/watch.ts";

const emlxBuf = (mid: string) => {
  const rfc = `From: A <a@x>\r\nSubject: S\r\nMessage-ID: <${mid}>\r\nContent-Type: text/plain\r\n\r\nbody\r\n`;
  const body = Buffer.from(rfc);
  return Buffer.concat([Buffer.from(String(body.length) + "\n"), body, Buffer.from("<plist></plist>\n")]);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("watcher ingests new files and soft-deletes removed ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "watch-"));
  const msgs = join(root, "ACC", "INBOX.mbox", "B", "Data", "Messages");
  mkdirSync(msgs, { recursive: true });
  const s = Store.open(":memory:");
  const w = startWatch({ store: s, blobs: new BlobStore(join(root, "blobs")) }, root);
  await wait(300);

  const p = join(msgs, "1.emlx");
  writeFileSync(p, emlxBuf("w1@x"));
  for (let i = 0; i < 40 && !s.getMessage("w1@x"); i++) await wait(100);
  assert.ok(s.getMessage("w1@x"), "ingested on add");

  rmSync(p);
  let del = 0;
  for (let i = 0; i < 40 && del === 0; i++) {
    await wait(100);
    const r = s.raw.prepare("SELECT deleted FROM messages WHERE message_id=?").get("w1@x") as { deleted: number };
    del = r?.deleted ?? 0;
  }
  assert.equal(del, 1, "soft-deleted on unlink");
  await w.close();
  s.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find `../src/watch.ts`.

- [ ] **Step 4: Implement**

`apps/mail-mirror/src/watch.ts`:
```ts
import { statSync } from "node:fs";
import chokidar from "chokidar";
import { entryForPath } from "./locator.ts";
import { ingestEmlxFile, type SyncDeps } from "./sync.ts";

export function startWatch(deps: SyncDeps, mailRoot: string): { close(): Promise<void> } {
  const watcher = chokidar.watch(mailRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  const onUpsert = async (path: string) => {
    if (!path.endsWith(".emlx")) return;
    let mtimeMs = Date.now();
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return;
    }
    await ingestEmlxFile(deps, entryForPath(mailRoot, path, mtimeMs));
  };

  const onUnlink = (path: string) => {
    if (!path.endsWith(".emlx")) return;
    const row = deps.store.raw.prepare("SELECT message_id FROM messages WHERE emlx_path=?").get(path) as { message_id: string } | undefined;
    if (row) deps.store.softDelete(row.message_id);
  };

  watcher.on("add", onUpsert).on("change", onUpsert).on("unlink", onUnlink);
  return { close: () => watcher.close() };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS (watcher test may take a few seconds).

- [ ] **Step 6: Commit**

```bash
git add apps/mail-mirror/src/watch.ts apps/mail-mirror/src/locator.ts apps/mail-mirror/test/watch.test.ts
git commit -m "feat(mail-mirror): FSEvents watcher (chokidar) for live sync"
```

---

### Task 10: AppleScript fallback (fill partial bodies, reusing mail-mcp)

**Files:**
- Create: `apps/mail-mirror/src/applescript-fallback.ts`
- Test: `apps/mail-mirror/test/applescript-fallback.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 4); reuses `readScript` from `apps/mail-mcp/src/applescript.ts`, `parseDetail` from `apps/mail-mcp/src/parse.ts`, and the `OsaExec` type / `runOsa` from `apps/mail-mcp/src/osascript.ts`.
- Produces:
  - `async fillBody(store: Store, messageId: string, run?: (script: string) => Promise<string>): Promise<boolean>` — for a row whose `body_state != 'full'`, run mail-mcp's `readScript({ messageId })` via `run` (defaults to `runOsa`), parse with `parseDetail`, and update `body_text`/`body_state='full'`/`source='applescript'`. Returns `true` if filled.

- [ ] **Step 1: Write failing test (injectable runner — no real Mail)**

`apps/mail-mirror/test/applescript-fallback.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";
import { fillBody } from "../src/applescript-fallback.ts";

const US = "\x1f";

function partialRow(): MessageRow {
  return {
    messageId: "p1@x", account: "ACC", mailbox: "INBOX",
    fromName: "A", fromAddr: "a@x", to: ["me@x"], cc: [],
    subject: "Subj", date: 1750000000, bodyText: "", bodyState: "none",
    source: "emlx", emlxPath: "/p/1.partial.emlx", inReplyTo: null,
    references: [], gmThrid: null, size: 0,
  };
}

test("fillBody pulls the body via the (stub) AppleScript runner and marks full", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(partialRow());
  // mail-mcp parseDetail expects: subject US sender US date US body
  const fakeOut = ["Subj", "A <a@x>", "2026", "DOWNLOADED BODY TEXT"].join(US);
  const ok = await fillBody(s, "p1@x", async () => fakeOut);
  assert.equal(ok, true);
  const got = s.getMessage("p1@x")!;
  assert.equal(got.bodyState, "full");
  assert.equal(got.source, "applescript");
  assert.ok(got.bodyText.includes("DOWNLOADED BODY TEXT"));
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find `../src/applescript-fallback.ts`.

- [ ] **Step 3: Implement (reusing mail-mcp)**

`apps/mail-mirror/src/applescript-fallback.ts`:
```ts
import { readScript } from "../../mail-mcp/src/applescript.ts";
import { parseDetail } from "../../mail-mcp/src/parse.ts";
import { runOsa } from "../../mail-mcp/src/osascript.ts";
import type { Store } from "./store.ts";

export async function fillBody(
  store: Store,
  messageId: string,
  run: (script: string) => Promise<string> = (s) => runOsa(s, { timeoutMs: 90_000 }),
): Promise<boolean> {
  const row = store.getMessage(messageId);
  if (!row || row.bodyState === "full") return false;
  const out = await run(readScript({ messageId }));
  const detail = parseDetail(out);
  if (!detail.body || detail.body.startsWith("[body unavailable")) return false;
  store.upsertMessage({ ...row, bodyText: detail.body, bodyState: "full", source: "applescript" });
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/applescript-fallback.ts apps/mail-mirror/test/applescript-fallback.test.ts
git commit -m "feat(mail-mirror): AppleScript fallback to fill partial bodies (reuses mail-mcp)"
```

---

### Task 11: CLI + LaunchAgent + README

**Files:**
- Create: `apps/mail-mirror/src/cli.ts`
- Create: `apps/mail-mirror/src/paths.ts`
- Create: `apps/mail-mirror/launchagent/com.llmwiki.mailmirror.plist`
- Create: `apps/mail-mirror/README.md`
- Test: `apps/mail-mirror/test/paths.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `paths.ts`: `function storeDir(): string` (`MAIL_MIRROR_DIR` or `~/Library/Application Support/mail-mirror`, created `0700`); `function dbPath(): string`; `function blobsDir(): string`.
  - `cli.ts`: commands `backfill`, `watch`, `reconcile`, `status` wired to `sync`/`watch`/`locator`.

- [ ] **Step 1: Write failing test for paths**

`apps/mail-mirror/test/paths.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeDir, dbPath, blobsDir } from "../src/paths.ts";

test("storeDir honours MAIL_MIRROR_DIR and creates it 0700", () => {
  const base = mkdtempSync(join(tmpdir(), "md-"));
  process.env.MAIL_MIRROR_DIR = join(base, "mm");
  const d = storeDir();
  assert.equal(d, join(base, "mm"));
  assert.ok(dbPath().endsWith("mail.db"));
  assert.ok(blobsDir().endsWith("blobs"));
  const mode = statSync(d).mode & 0o777;
  assert.equal(mode, 0o700);
  delete process.env.MAIL_MIRROR_DIR;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find `../src/paths.ts`.

- [ ] **Step 3: Implement paths**

`apps/mail-mirror/src/paths.ts`:
```ts
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function storeDir(): string {
  const dir = process.env.MAIL_MIRROR_DIR ?? join(homedir(), "Library", "Application Support", "mail-mirror");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function dbPath(): string {
  return join(storeDir(), "mail.db");
}

export function blobsDir(): string {
  return join(storeDir(), "blobs");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mirror && npm test`
Expected: PASS.

- [ ] **Step 5: Implement the CLI**

`apps/mail-mirror/src/cli.ts`:
```ts
#!/usr/bin/env -S node --import tsx
import { Store } from "./store.ts";
import { BlobStore } from "./blobstore.ts";
import { backfill, reconcile, type SyncDeps } from "./sync.ts";
import { startWatch } from "./watch.ts";
import { findMailRoot, canRead } from "./locator.ts";
import { dbPath, blobsDir } from "./paths.ts";

function deps(): SyncDeps {
  return { store: Store.open(dbPath()), blobs: new BlobStore(blobsDir()) };
}

function requireMailRoot(): string {
  const root = findMailRoot();
  if (!root) {
    console.error("No Apple Mail store found under ~/Library/Mail/V*.");
    process.exit(2);
  }
  if (!canRead(root)) {
    console.error("Cannot read the Mail store. Grant Full Disk Access to this process in");
    console.error("System Settings -> Privacy & Security -> Full Disk Access, then retry.");
    process.exit(3);
  }
  return root;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "backfill") {
    const root = requireMailRoot();
    const d = deps();
    const res = await backfill(d, root);
    console.log(`backfill: ingested ${res.ingested}`);
    d.store.close();
  } else if (cmd === "reconcile") {
    const root = requireMailRoot();
    const d = deps();
    const res = await reconcile(d, root);
    console.log(`reconcile: ingested ${res.ingested}, deleted ${res.deleted}`);
    d.store.close();
  } else if (cmd === "watch") {
    const root = requireMailRoot();
    const d = deps();
    startWatch(d, root);
    console.log(`watching ${root} (Ctrl+C to stop)`);
  } else if (cmd === "status") {
    const d = deps();
    const total = d.store.raw.prepare("SELECT COUNT(*) c FROM messages WHERE deleted=0").get() as { c: number };
    const full = d.store.raw.prepare("SELECT COUNT(*) c FROM messages WHERE body_state='full' AND deleted=0").get() as { c: number };
    const threads = d.store.raw.prepare("SELECT COUNT(*) c FROM threads").get() as { c: number };
    console.log(`messages: ${total.c} (full bodies: ${full.c}), threads: ${threads.c}`);
    console.log(`db: ${dbPath()}`);
    d.store.close();
  } else {
    console.log("usage: mail-mirror <backfill|watch|reconcile|status>");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 6: Create the LaunchAgent template**

`apps/mail-mirror/launchagent/com.llmwiki.mailmirror.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.llmwiki.mailmirror</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>--import</string>
    <string>tsx</string>
    <string>REPLACE_WITH_ABSOLUTE_PATH/apps/mail-mirror/src/cli.ts</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/mail-mirror.err.log</string>
  <key>StandardOutPath</key><string>/tmp/mail-mirror.out.log</string>
</dict>
</plist>
```

- [ ] **Step 7: Write the README**

`apps/mail-mirror/README.md` (full content):
```markdown
# mail-mirror

Local SQLite mirror of Apple Mail (sub-project 1/3). See
`docs/superpowers/specs/2026-06-18-mail-mirror-store-design.md`.

## Setup

1. Install deps: `npm install` (from repo root or this folder).
2. Grant **Full Disk Access** to the process that runs the watcher (the
   `node`/`tsx` binary, or the Terminal/daemon launching it) in
   System Settings -> Privacy & Security -> Full Disk Access.
3. Initial backfill (recent-first): `npm run -w @llm-wiki/mail-mirror exec -- node --import tsx src/cli.ts backfill`
   or `cd apps/mail-mirror && node --import tsx src/cli.ts backfill`.
4. Check progress: `node --import tsx src/cli.ts status`.

## Live sync (LaunchAgent)

1. Edit `launchagent/com.llmwiki.mailmirror.plist`, replacing
   `REPLACE_WITH_ABSOLUTE_PATH` with the absolute repo path.
2. Copy to `~/Library/LaunchAgents/` and load:
   `cp launchagent/com.llmwiki.mailmirror.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.llmwiki.mailmirror.plist`
3. The watcher keeps the DB live; run `reconcile` nightly (add a second
   LaunchAgent with `StartCalendarInterval`, or cron) to catch missed changes.

## Commands

- `backfill` — ingest all on-disk `.emlx` (recent-first).
- `watch` — live FSEvents sync.
- `reconcile` — diff disk vs DB; ingest new, soft-delete removed.
- `status` — counts (messages, full bodies, threads) and DB path.

## Coverage note

~Half of messages may be `.partial.emlx` (body not downloaded). Those rows have
`body_state` of `partial`/`none`; sub-project 2 fills them on demand via the
AppleScript fallback (`src/applescript-fallback.ts`). To raise local coverage,
enable "Download all messages / attachments" per account in Mail settings.
```

- [ ] **Step 8: Manual verification (real store; requires Full Disk Access)**

Run: `cd apps/mail-mirror && node --import tsx src/cli.ts status` then `... backfill` (let it run; recent first) then `... status`.
Expected: `status` shows a growing message count and a `full bodies` count below the total (reflecting partials). No crash on `.partial.emlx`.

- [ ] **Step 9: Commit**

```bash
git add apps/mail-mirror/src/cli.ts apps/mail-mirror/src/paths.ts apps/mail-mirror/launchagent/com.llmwiki.mailmirror.plist apps/mail-mirror/README.md apps/mail-mirror/test/paths.test.ts
git commit -m "feat(mail-mirror): CLI, LaunchAgent template, README"
```

---

## Self-review notes (addressed)

- **Spec coverage:** `.emlx` parse (T2), blobstore (T3), schema+FTS+dedup+soft-delete (T4), threads/union-find+subject fallback (T5), locator+FDA (T6), ingest+thread assignment+body_state (T7), recent-first backfill + reconcile (T8), FSEvents watch (T9), AppleScript fallback reusing mail-mcp (T10), CLI+LaunchAgent+README+privacy paths (T11). Out-of-scope items (embeddings, mail-mcp search rewrite, wiki promotion, sending) are correctly absent.
- **Type consistency:** `SyncDeps`, `MessageRow`, `BodyState`, `EmlxEntry`, `ParsedMessage` names are used identically across tasks; `ingestEmlxFile(deps, entry)` signature is stable from T7 onward.
- **Reuse:** the AppleScript fallback imports mail-mcp modules (no duplication), per the global constraint.
```
