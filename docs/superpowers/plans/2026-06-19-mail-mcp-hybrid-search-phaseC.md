# Mail-MCP Hybrid Search (Phase C of sub-project 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewire `mail-mcp`'s `search_messages` and `read_message` to query the local Mail DB (sub-project 1 + Phase B) — hybrid FTS(BM25) + vector(KNN) fused with RRF, real filters, thread-grouped results; `read_message` served from the DB with a scoped AppleScript fallback for not-yet-downloaded bodies. Send/reply/save/list stay AppleScript.

**Architecture:** A pure RRF module fuses an FTS ranking and a vector ranking. `db-search` opens the Mail DB read-only (via a new `Store.openReadonly`), builds SQL filters from `SearchArgs`, runs filtered FTS + (when embeddings exist and dims agree) KNN, fuses with RRF, groups by `thread_id`, and returns `MessageSummary[]`. `read_message` reads from the DB and falls back to a scoped AppleScript read (account+mailbox) when the body is not downloaded. mail-mcp imports the Store + embedding client from `apps/mail-mirror` (cross-workspace, as the AppleScript fallback already does the reverse).

**Tech Stack:** TypeScript ESM, `better-sqlite3` + `sqlite-vec` (via mail-mirror's Store), `@llm-wiki/embedding`. Tests: `node --import tsx --test`.

Spec: `docs/superpowers/specs/2026-06-18-mail-hybrid-search-design.md` (Phase C). Builds on `apps/mail-mirror` (Store, `knn`, `embedText`, `loadEmbedConfig`, `dbPath`, vec_dim sentinel) and `packages/embedding`.

## Global Constraints

- mail-mcp opens the Mail DB **read-only** (the mirror is the only writer) — read_message must NOT write the DB (a freshly fetched body is returned to the agent; the mirror persists it later when Mail downloads the .emlx and FSEvents re-ingests).
- Embeddings OPTIONAL: no `MAIL_EMBED_ENDPOINT`, unreachable, or a query-embed dimension that disagrees with the stored `vec_dim` sentinel → **FTS-only** search, never throw.
- RRF: `score = Σ 1/(K + rank_i)`, K = 60. Pure function.
- Results grouped by `thread_id` by default (one row per thread, best-scoring message), with thread metadata; a `perMessage` flag returns ungrouped.
- KNN already filters `deleted=0` (Phase B). FTS and all filters must also exclude `deleted=0`.
- `account` filter matches the stored `m.account` value (the account UUID — sub-project 1). Friendly account-name filtering is a documented follow-up (the mirror would need to store names). `mailbox` matches the `.mbox` base name (e.g. INBOX, Sent Items).
- Reuse: import `Store`/`dbPath`/`loadEmbedConfig`/`embedText` from `apps/mail-mirror` via relative paths; the scoped read reuses mail-mcp's `osascript`/`parse`.
- Mail DB missing/empty → `search_messages` returns a clear "mirror not populated — run mail-mirror backfill" message, not silence.
- ESM TypeScript; new mail-mcp deps allowed: `better-sqlite3`, `sqlite-vec`, `@llm-wiki/embedding` (resolve the cross-workspace imports). No others.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; no apostrophes in heredoc commit bodies.

## File Structure

- `apps/mail-mirror/src/store.ts` — MODIFY: add `Store.openReadonly(path)` (open `{ readonly: true }`, skip WAL pragma + schema).
- `apps/mail-mcp/package.json` — MODIFY: add `better-sqlite3`, `sqlite-vec`, `@llm-wiki/embedding` deps.
- `apps/mail-mcp/src/rrf.ts` — CREATE: pure reciprocal rank fusion.
- `apps/mail-mcp/src/filters.ts` — CREATE: `SearchArgs` → SQL WHERE clause + params (pure).
- `apps/mail-mcp/src/db-search.ts` — CREATE: `searchDb(store, args, embedQuery?)` → `MessageSummary[]`.
- `apps/mail-mcp/src/db-read.ts` — CREATE: `readDb(store, ref, runScoped?)` → message detail (+ scoped fallback).
- `apps/mail-mcp/src/applescript.ts` — MODIFY: add `scopedReadScript(account, mailbox, ref)`.
- `apps/mail-mcp/src/mail.ts` — MODIFY: `search`/`read` delegate to `db-search`/`db-read`; keep send/reply/save/list.
- `apps/mail-mcp/src/index.ts` — MODIFY: open the Store once; pass it to `Mail`; the DB-empty message.
- `apps/mail-mcp/test/*.test.ts` — tests.

---

### Task 1: RRF (reciprocal rank fusion)

**Files:**
- Create: `apps/mail-mcp/src/rrf.ts`, `apps/mail-mcp/test/rrf.test.ts`

**Interfaces:**
- Produces: `rrf(rankings: string[][], k?: number): { id: string; score: number }[]` — each input is an ordered list of ids (best first); returns ids sorted by fused score descending. Default k = 60.

- [ ] **Step 1: Write failing test**

`apps/mail-mcp/test/rrf.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { rrf } from "../src/rrf.ts";

test("rrf fuses two rankings; shared high-rank items win", () => {
  const fts = ["a", "b", "c"];
  const vec = ["b", "a", "d"];
  const out = rrf([fts, vec]);
  // b is rank0+rank1, a is rank1+rank... b and a both appear in both; b scores highest
  assert.equal(out[0].id, "b");
  assert.ok(out.find((r) => r.id === "a"));
  assert.ok(out.find((r) => r.id === "d")); // appears in one list only, still included
  // scores strictly descending
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
});

test("rrf with one ranking preserves its order", () => {
  assert.deepEqual(rrf([["x", "y", "z"]]).map((r) => r.id), ["x", "y", "z"]);
});

test("rrf empty input is empty", () => {
  assert.deepEqual(rrf([]), []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mail-mcp && npm test`
Expected: FAIL — cannot find `../src/rrf.ts`.

- [ ] **Step 3: Implement**

`apps/mail-mcp/src/rrf.ts`:
```ts
/** Reciprocal Rank Fusion. Each ranking is an ordered id list (best first). */
export function rrf(rankings: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/mail-mcp && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mcp/src/rrf.ts apps/mail-mcp/test/rrf.test.ts
git commit -m "feat(mail-mcp): reciprocal rank fusion module"
```

---

### Task 2: Read-only Store + SQL filter builder

**Files:**
- Modify: `apps/mail-mirror/src/store.ts` (add `openReadonly`)
- Modify: `apps/mail-mcp/package.json` (add deps)
- Create: `apps/mail-mcp/src/filters.ts`, `apps/mail-mcp/test/filters.test.ts`
- Test (mail-mirror): `apps/mail-mirror/test/store-readonly.test.ts`

**Interfaces:**
- Produces:
  - `Store.openReadonly(path: string): Store` — opens read-only (`fileMustExist: true`), does NOT run WAL pragma or schema. Read methods work; writes throw (by design).
  - `interface DbFilters { account?: string; mailbox?: string; sender?: string; recipient?: string; dateFrom?: number; dateTo?: number; unreadOnly?: boolean; flaggedOnly?: boolean; hasAttachments?: boolean; }`
  - `buildFilterSql(f: DbFilters): { clause: string; params: unknown[] }` — returns a WHERE fragment (always includes `m.deleted=0`) and its params. `clause` is the text after `WHERE` (e.g. `m.deleted=0 AND m.account=?`).

- [ ] **Step 1: Add deps to mail-mcp**

In `apps/mail-mcp/package.json` `dependencies`, add: `"better-sqlite3": "^11.0.0"`, `"sqlite-vec": "^0.1.7-alpha.2"`, `"@llm-wiki/embedding": "*"`. Run `npm install` from the repo root.

- [ ] **Step 2: Write failing tests**

`apps/mail-mirror/test/store-readonly.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

test("openReadonly reads an existing DB; writes throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "ro-"));
  const path = join(dir, "mail.db");
  const w = Store.open(path);
  w.raw.prepare("INSERT INTO sync_state(key,value) VALUES ('k','v')").run();
  w.close();

  const r = Store.openReadonly(path);
  assert.equal(r.getState("k"), "v");
  assert.throws(() => r.setState("x", "y")); // read-only connection rejects writes
  r.close();
});
```

`apps/mail-mcp/test/filters.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFilterSql } from "../src/filters.ts";

test("empty filters only exclude deleted", () => {
  const { clause, params } = buildFilterSql({});
  assert.equal(clause, "m.deleted=0");
  assert.deepEqual(params, []);
});

test("filters compose with params in order", () => {
  const { clause, params } = buildFilterSql({
    account: "ACC", mailbox: "INBOX", sender: "trenitalia",
    dateFrom: 1000, dateTo: 2000, unreadOnly: true, flaggedOnly: true, hasAttachments: true,
  });
  assert.match(clause, /m\.deleted=0/);
  assert.match(clause, /m\.account=\?/);
  assert.match(clause, /m\.mailbox=\?/);
  assert.match(clause, /from_addr LIKE \? OR m\.from_name LIKE \?/);
  assert.match(clause, /m\.date>=\? AND m\.date<=\?/);
  assert.match(clause, /m\.unread=1/);
  assert.match(clause, /m\.flagged=1/);
  assert.match(clause, /EXISTS \(SELECT 1 FROM attachments/);
  assert.deepEqual(params, ["ACC", "INBOX", "%trenitalia%", "%trenitalia%", 1000, 2000]);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/mail-mirror && npm test` then `cd apps/mail-mcp && npm test`
Expected: FAIL — `openReadonly` not defined; `../src/filters.ts` missing.

- [ ] **Step 4: Implement**

In `apps/mail-mirror/src/store.ts`, refactor the constructor to accept a readonly flag and add `openReadonly`:
```ts
  constructor(db: Database.Database, opts: { readonly?: boolean } = {}) {
    this.raw = db;
    if (!opts.readonly) {
      db.pragma("journal_mode = WAL");
      db.exec(SCHEMA);
    }
  }

  static open(path: string): Store {
    return new Store(new Database(path));
  }

  static openReadonly(path: string): Store {
    return new Store(new Database(path, { readonly: true, fileMustExist: true }), { readonly: true });
  }
```
(Keep the existing `open` behaviour identical. The existing body of the constructor moves inside the `if (!opts.readonly)` guard.)

`apps/mail-mcp/src/filters.ts`:
```ts
export interface DbFilters {
  account?: string;
  mailbox?: string;
  sender?: string;
  recipient?: string;
  dateFrom?: number;
  dateTo?: number;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  hasAttachments?: boolean;
}

export function buildFilterSql(f: DbFilters): { clause: string; params: unknown[] } {
  const conds: string[] = ["m.deleted=0"];
  const params: unknown[] = [];
  if (f.account) { conds.push("m.account=?"); params.push(f.account); }
  if (f.mailbox) { conds.push("m.mailbox=?"); params.push(f.mailbox); }
  if (f.sender) { conds.push("(m.from_addr LIKE ? OR m.from_name LIKE ?)"); params.push(`%${f.sender}%`, `%${f.sender}%`); }
  if (f.recipient) { conds.push("m.to_addrs LIKE ?"); params.push(`%${f.recipient}%`); }
  if (typeof f.dateFrom === "number") { conds.push("m.date>=?"); params.push(f.dateFrom); }
  if (typeof f.dateTo === "number") { conds.push("m.date<=?"); params.push(f.dateTo); }
  if (f.unreadOnly) conds.push("m.unread=1");
  if (f.flaggedOnly) conds.push("m.flagged=1");
  if (f.hasAttachments) conds.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.message_id)");
  return { clause: conds.join(" AND "), params };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/mail-mirror && npm test && npm run typecheck` then `cd apps/mail-mcp && npm test && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mail-mirror/src/store.ts apps/mail-mirror/test/store-readonly.test.ts apps/mail-mcp/package.json apps/mail-mcp/src/filters.ts apps/mail-mcp/test/filters.test.ts package-lock.json
git commit -m "feat(mail-mcp): read-only Store open and SQL filter builder"
```

---

### Task 3: Hybrid DB search (FTS + vector + RRF + thread grouping)

**Files:**
- Create: `apps/mail-mcp/src/db-search.ts`, `apps/mail-mcp/test/db-search.test.ts`

**Interfaces:**
- Consumes: `Store` (read-only), `Store.knn`, `Store.getState` (vec_dim sentinel), `buildFilterSql` (Task 2), `rrf` (Task 1), `MessageSummary` (mail-mcp types).
- Produces:
  - `interface SearchDbArgs extends DbFilters { query?: string; limit?: number; perMessage?: boolean; }`
  - `async searchDb(store: Store, args: SearchDbArgs, embedQuery?: (text: string) => Promise<number[] | null>): Promise<MessageSummary[]>`
    - With `query`: filtered FTS ranking (ids) + (if `embedQuery` returns a vector whose length === the stored `vec_dim`) filtered KNN ranking (ids) → `rrf` → ordered ids. Without `query`: filtered messages by `date DESC`.
    - Group by `thread_id` unless `perMessage`; one row per thread (best-ranked message). Returns up to `limit` (default 20) `MessageSummary` with `threadId` + `score`.

- [ ] **Step 1: Write failing test**

`apps/mail-mcp/test/db-search.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { searchDb } from "../src/db-search.ts";

function row(id: string, subject: string, body: string, thread: number, date = 1750000000): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "T", fromAddr: "noreply@trenitalia.it",
    to: ["me@x"], cc: [], subject, date, bodyText: body, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

function seeded(): Store {
  const s = Store.open(":memory:");
  s.enableVectors(); s.ensureVecTable(4);
  s.upsertMessage(row("a@x", "Sconto viaggi", "Frecciarossa Roma Milano -20%", 1));
  s.setThreadId("a@x", 1);
  s.upsertMessage(row("b@x", "Ricetta torta", "uova farina zucchero", 2));
  s.setThreadId("b@x", 2);
  return s;
}

test("FTS-only search finds the travel promo by body term", async () => {
  const s = seeded();
  const hits = await searchDb(s, { query: "frecciarossa", limit: 5 });
  assert.equal(hits[0].messageId, "a@x");
  assert.ok(!hits.find((h) => h.messageId === "b@x"));
  s.close();
});

test("hybrid: vector ranking fused via RRF (stub embedder)", async () => {
  const s = seeded();
  s.upsertEmbedding("a@x", [1, 0, 0, 0], "m", "ha");
  s.upsertEmbedding("b@x", [0, 0, 1, 0], "m", "hb");
  // query embed near a@x; query term matches neither subject/body strongly
  const hits = await searchDb(s, { query: "treni veloci", limit: 5 }, async () => [0.95, 0.05, 0, 0]);
  assert.equal(hits[0].messageId, "a@x");
  s.close();
});

test("filters apply; thread grouping returns one row per thread", async () => {
  const s = seeded();
  s.upsertMessage(row("a2@x", "Re: Sconto viaggi", "altra promo treni", 1)); // same thread 1
  s.setThreadId("a2@x", 1);
  const hits = await searchDb(s, { query: "viaggi", limit: 10 });
  const t1 = hits.filter((h) => h.threadId === 1);
  assert.equal(t1.length, 1); // grouped
  s.close();
});

test("no query returns recent-first filtered messages", async () => {
  const s = seeded();
  const hits = await searchDb(s, { sender: "trenitalia", limit: 5 });
  assert.ok(hits.find((h) => h.messageId === "a@x"));
  s.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mail-mcp && npm test`
Expected: FAIL — cannot find `../src/db-search.ts`.

- [ ] **Step 3: Implement**

`apps/mail-mcp/src/db-search.ts`:
```ts
import type { Store } from "../../mail-mirror/src/store.ts";
import type { MessageSummary } from "./types.ts";
import { buildFilterSql, type DbFilters } from "./filters.ts";
import { rrf } from "./rrf.ts";

export interface SearchDbArgs extends DbFilters {
  query?: string;
  limit?: number;
  perMessage?: boolean;
}

const CANDIDATES = 50;

export async function searchDb(
  store: Store,
  args: SearchDbArgs,
  embedQuery?: (text: string) => Promise<number[] | null>,
): Promise<MessageSummary[]> {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const { clause, params } = buildFilterSql(args);

  let orderedIds: string[];
  if (args.query) {
    const ftsIds = store.raw
      .prepare(`SELECT m.message_id FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
                WHERE messages_fts MATCH ? AND ${clause} ORDER BY rank LIMIT ${CANDIDATES}`)
      .all(args.query, ...params)
      .map((r) => (r as { message_id: string }).message_id);

    let vecIds: string[] = [];
    if (embedQuery) {
      const qv = await embedQuery(args.query);
      const vecDim = Number(store.getState("vec_dim") ?? 0);
      if (qv && qv.length === vecDim) {
        const hits = store.knn(qv, CANDIDATES).map((h) => h.messageId);
        if (hits.length) {
          // keep only those passing the filters, preserving knn order
          const placeholders = hits.map(() => "?").join(",");
          const allowed = new Set(
            store.raw
              .prepare(`SELECT m.message_id FROM messages m WHERE ${clause} AND m.message_id IN (${placeholders})`)
              .all(...params, ...hits)
              .map((r) => (r as { message_id: string }).message_id),
          );
          vecIds = hits.filter((id) => allowed.has(id));
        }
      }
    }
    orderedIds = vecIds.length ? rrf([ftsIds, vecIds]).map((r) => r.id) : ftsIds;
  } else {
    orderedIds = store.raw
      .prepare(`SELECT m.message_id FROM messages m WHERE ${clause} ORDER BY m.date DESC LIMIT ${CANDIDATES}`)
      .all(...params)
      .map((r) => (r as { message_id: string }).message_id);
  }

  // Load summaries in ranked order; group by thread (best-ranked wins) unless perMessage.
  const seenThreads = new Set<number>();
  const out: MessageSummary[] = [];
  for (const id of orderedIds) {
    const m = store.raw
      .prepare(`SELECT message_id, subject, from_addr, from_name, date, mailbox, account, snippet, thread_id
                FROM messages WHERE message_id=?`)
      .get(id) as
      | { message_id: string; subject: string; from_addr: string; from_name: string; date: number; mailbox: string; account: string; snippet: string; thread_id: number | null }
      | undefined;
    if (!m) continue;
    if (!args.perMessage && m.thread_id != null) {
      if (seenThreads.has(m.thread_id)) continue;
      seenThreads.add(m.thread_id);
    }
    out.push({
      id, messageId: m.message_id, subject: m.subject ?? "",
      from: m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr ?? "",
      date: String(m.date), mailbox: m.mailbox ?? "", account: m.account ?? "",
      snippet: m.snippet ?? "", threadId: m.thread_id ?? undefined,
    } as MessageSummary);
    if (out.length >= limit) break;
  }
  return out;
}
```
NOTE: this uses `MessageSummary` with optional `threadId`. In Task 5 you will add `threadId?: number` to the `MessageSummary` interface in `apps/mail-mcp/src/types.ts` — but add it NOW if `tsc` requires it for this file to typecheck (a one-line addition to `types.ts`: `threadId?: number;`). The `id` field already exists on `MessageSummary` (the native id from sub-project 1); here it carries the Mail DB message_id-keyed result — acceptable since the DB read tools accept `messageId`.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/mail-mcp && npm test && npm run typecheck`
Expected: all db-search tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mcp/src/db-search.ts apps/mail-mcp/src/types.ts apps/mail-mcp/test/db-search.test.ts
git commit -m "feat(mail-mcp): hybrid DB search with FTS, vector KNN, RRF, thread grouping"
```

---

### Task 4: DB read + scoped AppleScript fallback

**Files:**
- Modify: `apps/mail-mcp/src/applescript.ts` (add `scopedReadScript`)
- Create: `apps/mail-mcp/src/db-read.ts`, `apps/mail-mcp/test/db-read.test.ts`

**Interfaces:**
- Consumes: `Store` (read-only), the existing `parseDetail` (parse.ts), `readScript`/`esc` (applescript.ts), `runOsa` (osascript.ts).
- Produces:
  - `scopedReadScript(account: string, mailbox: string, messageId: string): string` — AppleScript that searches ONLY `account` + `mailbox` for `whose message id is`, returning the same US-delimited `subject US sender US date US body` as `readScript`.
  - `interface MailDetail { subject: string; from: string; date: string; body: string; attachments: { name: string; index: number }[]; bodyState: string; }`
  - `async readDb(store: Store, ref: { id?: string; messageId?: string }, runScoped?: (script: string) => Promise<string>): Promise<MailDetail>` — read the row + attachments from the DB; if `body_state !== 'full'`, run the scoped AppleScript read and use that body (do NOT write the DB). Throws a clear error if the message is not in the DB.

- [ ] **Step 1: Write failing test**

`apps/mail-mcp/test/db-read.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { readDb } from "../src/db-read.ts";
import { scopedReadScript } from "../src/applescript.ts";

const US = "\x1f";
function row(id: string, state: "full" | "none"): MessageRow {
  return {
    messageId: id, account: "Polimi", mailbox: "Posta in arrivo", fromName: "A", fromAddr: "a@x",
    to: ["me@x"], cc: [], subject: "Subj", date: 1750000000, bodyText: state === "full" ? "FULL BODY" : "",
    bodyState: state, source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

test("readDb returns the DB body when full (no AppleScript)", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a@x", "full"));
  let ran = false;
  const d = await readDb(s, { messageId: "a@x" }, async () => { ran = true; return ""; });
  assert.equal(d.body, "FULL BODY");
  assert.equal(d.bodyState, "full");
  assert.equal(ran, false);
  s.close();
});

test("readDb falls back to scoped AppleScript when not full", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("b@x", "none"));
  const fake = ["Subj", "A <a@x>", "2026", "DOWNLOADED"].join(US);
  const d = await readDb(s, { messageId: "b@x" }, async () => fake);
  assert.ok(d.body.includes("DOWNLOADED"));
  s.close();
});

test("scopedReadScript narrows to the given account + mailbox", () => {
  const sc = scopedReadScript("Polimi", "Posta in arrivo", "id@x");
  assert.match(sc, /name of acct is "Polimi"/);
  assert.match(sc, /name of mb is "Posta in arrivo"/);
  assert.match(sc, /whose message id is "id@x"/);
});

test("readDb throws a clear error when the message is unknown", async () => {
  const s = Store.open(":memory:");
  await assert.rejects(() => readDb(s, { messageId: "missing@x" }), /not found/i);
  s.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mail-mcp && npm test`
Expected: FAIL — `scopedReadScript`/`readDb` not defined.

- [ ] **Step 3: Implement**

Add to `apps/mail-mcp/src/applescript.ts`:
```ts
export function scopedReadScript(account: string, mailbox: string, messageId: string): string {
  return [
    "set US to (ASCII character 31)",
    'tell application "Mail"',
    "  set theMsg to missing value",
    "  repeat with acct in accounts",
    `    if name of acct is "${esc(account)}" then`,
    "      repeat with mb in mailboxes of acct",
    `        if name of mb is "${esc(mailbox)}" then`,
    "          try",
    `            set theMsg to (first message of mb whose message id is "${esc(messageId)}")`,
    "          end try",
    "          exit repeat",
    "        end if",
    "      end repeat",
    "      exit repeat",
    "    end if",
    "  end repeat",
    `  if theMsg is missing value then error "Message not found: ${esc(messageId)}"`,
    '  set theBody to ""',
    "  with timeout of 600 seconds",
    "    try",
    "      set theBody to (content of theMsg)",
    "    on error errMsg",
    '      set theBody to ("[body unavailable: " & errMsg & "]")',
    "    end try",
    "  end timeout",
    "  set out to (subject of theMsg) & US & (sender of theMsg) & US & ((date received of theMsg) as string) & US & theBody",
    "end tell",
    "return out",
  ].join("\n");
}
```
(`esc` is already exported from this file.)

`apps/mail-mcp/src/db-read.ts`:
```ts
import type { Store } from "../../mail-mirror/src/store.ts";
import { parseDetail } from "./parse.ts";
import { scopedReadScript } from "./applescript.ts";
import { runOsa } from "./osascript.ts";

export interface MailDetail {
  subject: string;
  from: string;
  date: string;
  body: string;
  attachments: { name: string; index: number }[];
  bodyState: string;
}

export async function readDb(
  store: Store,
  ref: { id?: string; messageId?: string },
  runScoped: (script: string) => Promise<string> = (s) => runOsa(s, { timeoutMs: 90_000 }),
): Promise<MailDetail> {
  const messageId = ref.messageId ?? ref.id ?? "";
  const row = store.getMessage(messageId);
  if (!row) throw new Error(`Message not found in the mail mirror: ${messageId}`);

  const attRows = store.raw
    .prepare("SELECT filename FROM attachments WHERE message_id=?")
    .all(messageId) as { filename: string }[];
  const attachments = attRows.map((a, i) => ({ name: a.filename, index: i + 1 }));

  let body = row.bodyText;
  let bodyState = row.bodyState;
  if (row.bodyState !== "full") {
    const out = await runScoped(scopedReadScript(row.account, row.mailbox, messageId));
    const detail = parseDetail(out);
    if (detail.body && !detail.body.startsWith("[body unavailable")) {
      body = detail.body;
      bodyState = "full";
    }
  }
  return {
    subject: row.subject,
    from: row.fromName ? `${row.fromName} <${row.fromAddr}>` : row.fromAddr,
    date: String(row.date),
    body,
    attachments,
    bodyState,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/mail-mcp && npm test && npm run typecheck`
Expected: pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mcp/src/applescript.ts apps/mail-mcp/src/db-read.ts apps/mail-mcp/test/db-read.test.ts
git commit -m "feat(mail-mcp): DB read with scoped AppleScript body fallback"
```

---

### Task 5: Wire search/read into mail-mcp (DB-backed)

**Files:**
- Modify: `apps/mail-mcp/src/mail.ts` (search/read delegate to the DB)
- Modify: `apps/mail-mcp/src/index.ts` (open the Store; DB-empty message; query-embed wiring)
- Test: `apps/mail-mcp/test/mail-db.test.ts`

**Interfaces:**
- Consumes: `searchDb` (Task 3), `readDb` (Task 4), `Store.openReadonly` (Task 2), `dbPath` + `loadEmbedConfig` + `embedText` (from `apps/mail-mirror`).
- Produces: `Mail.search`/`Mail.read` backed by the DB; `Mail` gains a constructor that accepts an injected `Store` + optional `embedQuery` for testability; the MCP server opens the read-only Store once at startup.

- [ ] **Step 1: Write failing test**

`apps/mail-mcp/test/mail-db.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { Mail } from "../src/mail.ts";

function row(id: string, subject: string, body: string): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "T", fromAddr: "noreply@trenitalia.it",
    to: ["me@x"], cc: [], subject, date: 1750000000, bodyText: body, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

test("Mail.search uses the DB (FTS body match)", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a@x", "Sconto", "Frecciarossa Roma Milano"));
  const mail = new Mail({ store: s });
  const hits = await mail.search({ query: "frecciarossa" } as any);
  assert.equal(hits[0].messageId, "a@x");
  s.close();
});

test("Mail.read uses the DB body", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a@x", "Sconto", "BODY HERE"));
  const mail = new Mail({ store: s });
  const d = await mail.read({ messageId: "a@x" } as any);
  assert.ok(d.body.includes("BODY HERE"));
  s.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mail-mcp && npm test`
Expected: FAIL — `Mail` does not accept a `{ store }` constructor / does not use the DB.

- [ ] **Step 3: Implement**

In `apps/mail-mcp/src/mail.ts`, give `Mail` an injectable DB + embedQuery and delegate search/read:
```ts
import type { Store } from "../../mail-mirror/src/store.ts";
import { searchDb, type SearchDbArgs } from "./db-search.ts";
import { readDb } from "./db-read.ts";
// ... keep existing imports for send/reply/save/list (AppleScript) ...

export interface MailDeps {
  store: Store;
  embedQuery?: (text: string) => Promise<number[] | null>;
  runner?: (script: string, timeoutMs?: number) => Promise<string>;
}

export class Mail {
  private readonly store: Store;
  private readonly embedQuery?: (text: string) => Promise<number[] | null>;
  private readonly run: (script: string, timeoutMs?: number) => Promise<string>;

  constructor(deps: MailDeps) {
    this.store = deps.store;
    this.embedQuery = deps.embedQuery;
    this.run = deps.runner ?? ((script, timeoutMs) => runOsa(script, { timeoutMs }));
  }

  async search(args: SearchArgs): Promise<MessageSummary[]> {
    return searchDb(this.store, args as unknown as SearchDbArgs, this.embedQuery);
  }

  async read(args: ReadArgs): Promise<{ subject: string; from: string; date: string; body: string; attachments: { name: string; index: number }[] }> {
    return readDb(this.store, args);
  }

  // listMailboxes / saveAttachment / send / reply stay AppleScript-backed, unchanged,
  // using this.run (the injected/default osascript runner).
}
```
(Keep the existing AppleScript-backed `listMailboxes`, `saveAttachment`, `send`, `reply` method bodies — they already use `runOsa`/`this.run`. Adjust them to use `this.run` if they currently used a private runner field of a different shape. `search` and `read` no longer touch AppleScript.)

In `apps/mail-mcp/src/index.ts`, open the read-only Store once and construct `Mail` with it; handle the empty/missing DB:
```ts
import { Store } from "../../mail-mirror/src/store.ts";
import { dbPath } from "../../mail-mirror/src/paths.ts";
import { loadEmbedConfig } from "../../mail-mirror/src/embed-config.ts";
import { embedText } from "../../mail-mirror/src/embed-client.ts";
import { existsSync } from "node:fs";

// near startup:
const path = dbPath();
const dbReady = existsSync(path);
const store = dbReady ? Store.openReadonly(path) : null;
if (store) store.enableVectors();
const embedCfg = loadEmbedConfig();
const embedQuery = embedCfg ? (text: string) => embedText(text, embedCfg) : undefined;
const mail = store ? new Mail({ store, embedQuery }) : null;
```
In the `search_messages` handler, if `mail` is null OR the DB has no messages, return the actionable message:
```ts
      case "search_messages": {
        if (!mail) return text({ error: "Mail mirror not found. Run: mail-mirror backfill" });
        const total = (store!.raw.prepare("SELECT COUNT(*) c FROM messages WHERE deleted=0").get() as { c: number }).c;
        if (total === 0) return text({ error: "Mail mirror is empty. Run: mail-mirror backfill" });
        return text(await mail.search(args as SearchArgs));
      }
      case "read_message":
        if (!mail) return text({ error: "Mail mirror not found. Run: mail-mirror backfill" });
        return text(await mail.read(args as ReadArgs));
```
Keep `list_mailboxes`/`save_attachment`/`send_email`/`reply` dispatching to the AppleScript-backed methods. Those still need a `Mail` instance even without the DB — construct a Mail (or a separate AppleScript helper) for them regardless. SIMPLEST: always construct `mail` with `store` possibly a throwaway in-memory Store when the real DB is missing, so the AppleScript actions still work; gate only `search`/`read` on `dbReady && total>0`. Choose the approach that keeps send/reply working when the mirror is absent, and note it in your report.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/mail-mcp && npm test && npm run typecheck`
Expected: mail-db tests pass; existing mail-mcp tests that constructed `Mail` the old way are updated to the new constructor (update them as needed — they are this workspace's own tests); typecheck clean.

- [ ] **Step 5: Manual smoke (real DB if present)**

If a Mail DB exists (from a prior `mail-mirror backfill`), run a quick MCP search via the host or a small harness; otherwise confirm `search_messages` returns the "run backfill" message. Document what you ran.

- [ ] **Step 6: Commit**

```bash
git add apps/mail-mcp/src/mail.ts apps/mail-mcp/src/index.ts apps/mail-mcp/test/mail-db.test.ts apps/mail-mcp/test
git commit -m "feat(mail-mcp): DB-backed search_messages and read_message"
```

---

## Self-review notes (addressed)

- **Spec coverage (Phase C):** RRF (T1), read-only Store + filters (T2), hybrid FTS+vector+RRF+thread-grouping with FTS-only/dim-mismatch fallback (T3), DB read + scoped AppleScript fallback without writing the DB (T4), wiring + DB-empty message + query-embed via mail-mirror config (T5). Send/reply/save/list remain AppleScript.
- **Read-only safety:** mail-mcp opens `Store.openReadonly`; `readDb` never writes (the mirror persists downloaded bodies later). Single-writer WAL preserved.
- **Graceful degradation:** no/!matching embeddings → FTS-only; missing/empty DB → actionable message.
- **Known limitation (documented):** the `account` filter matches the stored account UUID; friendly account-name filtering is a follow-up needing the mirror to store account names. `mailbox` (INBOX/Sent/…) works.
- **Type consistency:** `DbFilters`/`SearchDbArgs`, `searchDb`/`readDb`/`scopedReadScript`/`Store.openReadonly`, `MailDeps` used consistently from definition through consumers; `MessageSummary` gains `threadId?: number` in T3.
