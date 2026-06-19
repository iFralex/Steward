# Plan B — mail-mcp Advanced Search Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the mirror's enriched data (Plan A) through `mail-mcp`: account-aware + mailbox-role filtering, real flag filters, rich filters (cc / sender-domain / attachment / size / sort), field-scoped substring queries, and a `get_thread` tool.

**Architecture:** Extend the read-only `mail-mcp` search path. A capability probe lets the server degrade gracefully when the mirror has not been migrated. A scope resolver turns a friendly account email/name into its UUID and a mailbox role keyword into that account's actual mailbox names (via Plan A's `accounts` / `mailbox_roles`), with optional match-any-mailbox through `message_paths`. Field-scoped substring params hit Plan A's `searchTrig` trigram index and intersect with the existing hybrid (FTS BM25 ⊕ vector RRF) ranking.

**Tech Stack:** TypeScript (ESM, `tsx`), better-sqlite3 (read-only), MCP SDK, node:test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-19-mail-advanced-search-design.md` (Plan B — Advanced Search Surface, B1–B5).
- `mail-mcp` opens the DB READ-ONLY (`Store.openReadonly`) and must NEVER write to it. Plan A's migration runs only on the read-write mirror; therefore `mail-mcp` must PROBE for the enrichment surface and degrade gracefully (legacy search still works) when the mirror has not been migrated.
- Reuse Plan A's `Store` methods — do not reimplement: `searchTrig(field, needle, limit)`, `accountByEmailOrName(q)`, `roleForMailbox(accountUuid, mailbox)`, `mailboxesForRole(accountUuid, role)`. Columns now available on `messages`: `unread, flagged, answered, junk, flag_color, apple_thrid, to_names, cc_names`.
- Do NOT change `packages/embedding`, the wiki, or `apps/mail-mirror`. Embeddings stay subject+body; identity fields are matched lexically (trigram), never embedded.
- All AppleScript stays injected/runner-based as today (`get_thread` is DB-only — no AppleScript).
- Tests: from `apps/mail-mcp`, single file `node --import tsx --test test/<file>.test.ts`; whole suite `npm test`. Keep `tsc --noEmit` clean. The wiki embedding gate (90/90) must remain untouched.
- Roles are auto-discovered in Plan A; Plan B resolves a role KEYWORD (`drafts`, `sent`, `trash`, `junk`, `inbox`, `archive`, `important`, `flagged`) through `mailbox_roles`. A literal mailbox name still matches verbatim. NEVER hardcode localized mailbox names here.

---

### Task 1: Capability probe

**Files:**
- Create: `apps/mail-mcp/src/capabilities.ts`
- Test: `apps/mail-mcp/test/capabilities.test.ts` (create)

**Interfaces:**
- Consumes: a `Store`.
- Produces: `enrichmentReady(store: Store): boolean` — true when the `messages` table has the `to_names` column AND the `messages_trig` table exists (i.e. Plan A migration has run). Used by callers to gate the new filters/params and to surface an actionable hint.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mcp/test/capabilities.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Store } from "../../mail-mirror/src/store.ts";
import { enrichmentReady } from "../src/capabilities.ts";

test("enrichmentReady is true for a migrated (fresh) Store", () => {
  const s = Store.open(":memory:"); // fresh open runs full SCHEMA + migrate
  assert.equal(enrichmentReady(s), true);
  s.close();
});

test("enrichmentReady is false for a pre-enrichment DB", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (message_id TEXT PRIMARY KEY, account TEXT, mailbox TEXT, subject TEXT, body_text TEXT, deleted INTEGER DEFAULT 0)`);
  // Open read-only so the constructor does NOT migrate (mirrors mail-mcp usage).
  const ro = new Store(db, { readonly: true } as never);
  assert.equal(enrichmentReady(ro), false);
  ro.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mcp && node --import tsx --test test/capabilities.test.ts`
Expected: FAIL (`enrichmentReady` not a function).

- [ ] **Step 3: Implement**

```ts
// apps/mail-mcp/src/capabilities.ts
import type { Store } from "../../mail-mirror/src/store.ts";

/** True when the mirror has been enriched/migrated (Plan A): messages.to_names + messages_trig exist. */
export function enrichmentReady(store: Store): boolean {
  const cols = (store.raw.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((r) => r.name);
  if (!cols.includes("to_names")) return false;
  const trig = store.raw
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_trig'")
    .get();
  return trig !== undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mcp && node --import tsx --test test/capabilities.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mcp/src/capabilities.ts apps/mail-mcp/test/capabilities.test.ts
git commit -m "feat(mail-mcp): enrichment capability probe"
```

---

### Task 2: Rich scalar filters in buildFilterSql

**Files:**
- Modify: `apps/mail-mcp/src/filters.ts`
- Test: `apps/mail-mcp/test/filters.test.ts` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: `DbFilters`.
- Produces: `DbFilters` gains `answeredOnly?: boolean`, `junkOnly?: boolean`, `cc?: string`, `senderDomain?: string`, `attachmentType?: string`, `attachmentName?: string`, `minSize?: number`, `maxSize?: number`, `mailboxNames?: string[]`, `anyMailbox?: boolean`. `buildFilterSql` emits the matching SQL. (Existing `account`/`mailbox`/`sender`/`recipient`/`subject`/`dateFrom`/`dateTo`/`unreadOnly`/`flaggedOnly`/`hasAttachments` unchanged.)

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mcp/test/filters.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFilterSql } from "../src/filters.ts";

test("scalar enrichment filters emit clauses + params", () => {
  const { clause, params } = buildFilterSql({
    answeredOnly: true, junkOnly: true, cc: "boss@x", senderDomain: "polimi.it",
    attachmentType: "pdf", attachmentName: "fattura", minSize: 1000, maxSize: 5000,
  });
  assert.match(clause, /m\.answered=1/);
  assert.match(clause, /m\.junk=1/);
  assert.match(clause, /cc_addrs LIKE \? OR m\.cc_names LIKE \?/);
  assert.match(clause, /m\.from_addr LIKE \?/);          // senderDomain
  assert.match(clause, /a\.mime LIKE \? OR a\.filename LIKE \?/); // attachmentType
  assert.match(clause, /a\.filename LIKE \?/);            // attachmentName
  assert.match(clause, /m\.size>=\?/);
  assert.match(clause, /m\.size<=\?/);
  assert.ok(params.includes("%boss@x%"));
  assert.ok(params.includes("%@polimi.it"));   // senderDomain anchored
  assert.ok(params.includes(1000) && params.includes(5000));
});

test("mailboxNames with anyMailbox uses message_paths EXISTS", () => {
  const a = buildFilterSql({ mailboxNames: ["Bozze", "Drafts"], anyMailbox: true });
  assert.match(a.clause, /EXISTS \(SELECT 1 FROM message_paths mp WHERE mp\.message_id=m\.message_id AND mp\.mailbox IN \(\?,\?\)\)/);
  const b = buildFilterSql({ mailboxNames: ["Bozze"] });
  assert.match(b.clause, /m\.mailbox IN \(\?\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mcp && node --import tsx --test test/filters.test.ts`
Expected: FAIL (new fields produce no clauses).

- [ ] **Step 3: Implement**

Replace `apps/mail-mcp/src/filters.ts` with the extended version (keep existing fields, add new):

```ts
export interface DbFilters {
  account?: string;
  mailbox?: string;
  mailboxNames?: string[];
  anyMailbox?: boolean;
  subject?: string;
  sender?: string;
  recipient?: string;
  cc?: string;
  senderDomain?: string;
  dateFrom?: number;
  dateTo?: number;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  answeredOnly?: boolean;
  junkOnly?: boolean;
  hasAttachments?: boolean;
  attachmentType?: string;
  attachmentName?: string;
  minSize?: number;
  maxSize?: number;
}

export function buildFilterSql(f: DbFilters): { clause: string; params: unknown[] } {
  const conds: string[] = ["m.deleted=0"];
  const params: unknown[] = [];
  if (f.account) { conds.push("m.account=?"); params.push(f.account); }
  if (f.mailboxNames && f.mailboxNames.length) {
    const ph = f.mailboxNames.map(() => "?").join(",");
    if (f.anyMailbox) {
      conds.push(`EXISTS (SELECT 1 FROM message_paths mp WHERE mp.message_id=m.message_id AND mp.mailbox IN (${ph}))`);
    } else {
      conds.push(`m.mailbox IN (${ph})`);
    }
    params.push(...f.mailboxNames);
  } else if (f.mailbox) { conds.push("m.mailbox=?"); params.push(f.mailbox); }
  if (f.subject) { conds.push("m.subject LIKE ?"); params.push(`%${f.subject}%`); }
  if (f.sender) { conds.push("(m.from_addr LIKE ? OR m.from_name LIKE ?)"); params.push(`%${f.sender}%`, `%${f.sender}%`); }
  if (f.recipient) { conds.push("(m.to_addrs LIKE ? OR m.to_names LIKE ?)"); params.push(`%${f.recipient}%`, `%${f.recipient}%`); }
  if (f.cc) { conds.push("(m.cc_addrs LIKE ? OR m.cc_names LIKE ?)"); params.push(`%${f.cc}%`, `%${f.cc}%`); }
  if (f.senderDomain) { conds.push("m.from_addr LIKE ?"); params.push(`%@${f.senderDomain.replace(/^@/, "")}`); }
  if (typeof f.dateFrom === "number") { conds.push("m.date>=?"); params.push(f.dateFrom); }
  if (typeof f.dateTo === "number") { conds.push("m.date<=?"); params.push(f.dateTo); }
  if (f.unreadOnly) conds.push("m.unread=1");
  if (f.flaggedOnly) conds.push("m.flagged=1");
  if (f.answeredOnly) conds.push("m.answered=1");
  if (f.junkOnly) conds.push("m.junk=1");
  if (typeof f.minSize === "number") { conds.push("m.size>=?"); params.push(f.minSize); }
  if (typeof f.maxSize === "number") { conds.push("m.size<=?"); params.push(f.maxSize); }
  if (f.hasAttachments) conds.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.message_id)");
  if (f.attachmentType) { conds.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.message_id AND (a.mime LIKE ? OR a.filename LIKE ?))"); params.push(`%${f.attachmentType}%`, `%.${f.attachmentType.replace(/^\./, "")}`); }
  if (f.attachmentName) { conds.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.message_id AND a.filename LIKE ?)"); params.push(`%${f.attachmentName}%`); }
  return { clause: conds.join(" AND "), params };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mcp && node --import tsx --test test/filters.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing search tests (filter shape changed) then commit**

Run: `cd apps/mail-mcp && npm test`
Expected: green (new fields are additive/optional).

```bash
git add apps/mail-mcp/src/filters.ts apps/mail-mcp/test/filters.test.ts
git commit -m "feat(mail-mcp): rich scalar filters (cc/domain/attachment/size/flags)"
```

---

### Task 3: Scope resolver — friendly account + mailbox role + sort, wired into search

**Files:**
- Create: `apps/mail-mcp/src/scope.ts`
- Modify: `apps/mail-mcp/src/db-search.ts` (`SearchDbArgs`, resolve scope + sort)
- Test: `apps/mail-mcp/test/scope.test.ts` (create)

**Interfaces:**
- Consumes: `Store` (`accountByEmailOrName`, `mailboxesForRole`), `DbFilters`.
- Produces:
  - `scope.ts`: `resolveScope(store: Store, args: { account?: string; mailbox?: string; anyMailbox?: boolean }): { account?: string; mailboxNames?: string[]; anyMailbox?: boolean }`. `account`: if it matches an account email/name → that UUID, else passes through unchanged (literal/UUID). `mailbox`: if it is a known role keyword → that account's mailbox names from `mailbox_roles` (scoped to the resolved account when present, else across all accounts), else passed through as a single literal name. Returns `mailboxNames` for `buildFilterSql`.
  - `db-search.ts`: `SearchDbArgs` gains `sort?: "date" | "size"` and `sortDir?: "asc" | "desc"`; the non-query branch ORDER BY honours them (default `date desc`). `searchDb` calls `resolveScope` and feeds the result into `DbFilters`.
- `ROLE_KEYWORDS` exported from `scope.ts`: `["inbox","drafts","sent","trash","junk","archive","important","flagged"]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mcp/test/scope.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../mail-mirror/src/store.ts";
import { resolveScope } from "../src/scope.ts";

test("resolveScope maps account email to UUID and role keyword to mailbox names", () => {
  const s = Store.open(":memory:");
  s.upsertAccount("U1", "Business", ["biz@x.com"]);
  s.upsertMailboxRole("U1", "Bozze", "drafts");
  s.upsertMailboxRole("U1", "Posta inviata", "sent");
  const r = resolveScope(s, { account: "biz@x.com", mailbox: "drafts" });
  assert.equal(r.account, "U1");
  assert.deepEqual(r.mailboxNames, ["Bozze"]);
  s.close();
});

test("resolveScope passes through an unknown account and a literal mailbox name", () => {
  const s = Store.open(":memory:");
  const r = resolveScope(s, { account: "RAW-UUID", mailbox: "Custom Folder" });
  assert.equal(r.account, "RAW-UUID");
  assert.deepEqual(r.mailboxNames, ["Custom Folder"]);
  s.close();
});

test("resolveScope role across all accounts when no account given", () => {
  const s = Store.open(":memory:");
  s.upsertMailboxRole("U1", "Cestino", "trash");
  s.upsertMailboxRole("U2", "Trash", "trash");
  const r = resolveScope(s, { mailbox: "trash" });
  assert.deepEqual(new Set(r.mailboxNames), new Set(["Cestino", "Trash"]));
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mcp && node --import tsx --test test/scope.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`scope.ts`:

```ts
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
```

In `db-search.ts`: extend `SearchDbArgs` and wire resolution + sort.

```ts
export interface SearchDbArgs extends DbFilters {
  query?: string;
  limit?: number;
  offset?: number;
  perMessage?: boolean;
  sort?: "date" | "size";
  sortDir?: "asc" | "desc";
}
```

At the top of `searchDb`, before `buildFilterSql`, resolve scope and merge:

```ts
  const scope = resolveScope(store, { account: args.account, mailbox: args.mailbox, anyMailbox: args.anyMailbox });
  const filters: DbFilters = { ...args, account: scope.account, mailbox: undefined, mailboxNames: scope.mailboxNames, anyMailbox: scope.anyMailbox };
  const { clause, params } = buildFilterSql(filters);
```

(Import `resolveScope` from `./scope.ts`.) In the non-query branch, replace the fixed `ORDER BY m.date DESC` with a sort honouring `args.sort`/`args.sortDir`:

```ts
    const col = args.sort === "size" ? "m.size" : "m.date";
    const dir = args.sortDir === "asc" ? "ASC" : "DESC";
    orderedIds = store.raw
      .prepare(`SELECT m.message_id FROM messages m WHERE ${clause} ORDER BY ${col} ${dir} LIMIT ${CANDIDATES}`)
      .all(...params)
      .map((r) => (r as { message_id: string }).message_id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mcp && node --import tsx --test test/scope.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite (db-search changed) then commit**

Run: `cd apps/mail-mcp && npm test`
Expected: green.

```bash
git add apps/mail-mcp/src/scope.ts apps/mail-mcp/src/db-search.ts apps/mail-mcp/test/scope.test.ts
git commit -m "feat(mail-mcp): account/mailbox-role scope resolver + sort"
```

---

### Task 4: Field-scoped trigram substring params

**Files:**
- Modify: `apps/mail-mcp/src/db-search.ts` (intersect trigram matches)
- Test: `apps/mail-mcp/test/db-search-trig.test.ts` (create)

**Interfaces:**
- Consumes: Plan A's `Store.searchTrig(field, needle, limit)`; `SearchDbArgs`.
- Produces: `SearchDbArgs` gains `fromName?`, `fromAddr?`, `toName?`, `subjectContains?`, `bodyContains?`. Each present param restricts results to messages whose corresponding trigram field contains the substring (AND across params, intersected with the rest of the result set). Maps: `fromName→from_name`, `fromAddr→from_addr`, `toName→to_names`, `subjectContains→subject`, `bodyContains→body_text`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mcp/test/db-search-trig.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { searchDb } from "../src/db-search.ts";

function row(over: Partial<MessageRow>): MessageRow {
  return {
    messageId: "m", account: "A", mailbox: "INBOX", fromName: "Tom Jones", fromAddr: "a@b",
    to: ["x@y"], cc: [], toNames: ["Cristiana Rossi"], ccNames: [], subject: "Hi", date: 1750000000,
    bodyText: "hello world", bodyState: "full", source: "emlx", emlxPath: null, inReplyTo: null,
    references: [], gmThrid: null, size: 1, unread: false, flagged: false, answered: false, junk: false,
    flagColor: null, appleThrid: null, ...over,
  };
}

test("field-scoped trigram param filters by substring in that field", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row({ messageId: "m1", toNames: ["Cristiana Rossi"] }));
  s.upsertMessage(row({ messageId: "m2", toNames: ["Marco Bianchi"] }));
  const hits = await searchDb(s, { toName: "ristian", perMessage: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1");
  s.close();
});

test("multiple field-scoped params AND together", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row({ messageId: "m1", fromName: "Tom Jones", subject: "Invoice 2025" }));
  s.upsertMessage(row({ messageId: "m2", fromName: "Tom Jones", subject: "Holiday" }));
  const hits = await searchDb(s, { fromName: "Jones", subjectContains: "nvoice", perMessage: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1");
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mcp && node --import tsx --test test/db-search-trig.test.ts`
Expected: FAIL (params ignored — both rows returned / type error).

- [ ] **Step 3: Implement**

In `db-search.ts`, extend `SearchDbArgs`:

```ts
  fromName?: string;
  fromAddr?: string;
  toName?: string;
  subjectContains?: string;
  bodyContains?: string;
```

Add a helper and intersect after computing `orderedIds`. Define the field map and compute the allowed id set; when any trigram param is present, restrict `orderedIds`:

```ts
  const TRIG: [keyof SearchDbArgs, string][] = [
    ["fromName", "from_name"], ["fromAddr", "from_addr"], ["toName", "to_names"],
    ["subjectContains", "subject"], ["bodyContains", "body_text"],
  ];
  const trigParams = TRIG.filter(([k]) => typeof args[k] === "string" && (args[k] as string).length);
  if (trigParams.length) {
    let allowed: Set<string> | null = null;
    for (const [k, field] of trigParams) {
      const ids = new Set(store.searchTrig(field, args[k] as string, 500).filter((m) => m.deleted !== true).map((m) => m.messageId));
      allowed = allowed === null ? ids : new Set([...allowed].filter((id) => ids.has(id)));
    }
    const ok = allowed ?? new Set<string>();
    orderedIds = orderedIds.filter((id) => ok.has(id));
  }
```

Note: when there is no free-text `query`, the non-query branch must still produce candidates the trigram set can intersect with. The existing non-query branch selects by filters ordered by date — that already yields `orderedIds`; the intersection above narrows it. When `query` IS present, the hybrid `orderedIds` is narrowed the same way. `MessageRow` from `searchTrig` has no `deleted` field, so drop the `.filter((m) => m.deleted !== true)` (searchTrig already filters `deleted=0` internally) — use `store.searchTrig(field, args[k] as string, 500).map((m) => m.messageId)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mcp && node --import tsx --test test/db-search-trig.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the suite then commit**

Run: `cd apps/mail-mcp && npm test`
Expected: green.

```bash
git add apps/mail-mcp/src/db-search.ts apps/mail-mcp/test/db-search-trig.test.ts
git commit -m "feat(mail-mcp): field-scoped trigram substring params"
```

---

### Task 5: `get_thread` tool

**Files:**
- Create: `apps/mail-mcp/src/db-thread.ts`
- Modify: `apps/mail-mcp/src/mail.ts` (`getThread` method)
- Test: `apps/mail-mcp/test/db-thread.test.ts` (create)

**Interfaces:**
- Consumes: `Store`; `messages.thread_id` / `apple_thrid`.
- Produces:
  - `db-thread.ts`: `getThread(store: Store, ref: { threadId?: number; id?: string; messageId?: string }): MessageSummary[]` — resolves the thread (explicit `threadId`, else the `thread_id` of the given message) and returns every non-deleted message in it ordered by date ascending, as `MessageSummary` (same shape `searchDb` returns). Throws when the thread cannot be resolved.
  - `mail.ts`: `Mail.getThread(args): Promise<MessageSummary[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-mcp/test/db-thread.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { getThread } from "../src/db-thread.ts";

function row(id: string, date: number): MessageRow {
  return {
    messageId: id, account: "A", mailbox: "INBOX", fromName: "T", fromAddr: "a@b",
    to: ["x@y"], cc: [], toNames: [], ccNames: [], subject: "S", date, bodyText: "b",
    bodyState: "full", source: "emlx", emlxPath: null, inReplyTo: null, references: [],
    gmThrid: null, size: 1, unread: false, flagged: false, answered: false, junk: false,
    flagColor: null, appleThrid: null,
  };
}

test("getThread returns all messages in a thread, ordered by date asc", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("m1", 200));
  s.upsertMessage(row("m2", 100));
  s.setThreadId("m1", 7);
  s.setThreadId("m2", 7);
  const out = getThread(s, { messageId: "m1" });
  assert.deepEqual(out.map((m) => m.messageId), ["m2", "m1"]);
  s.close();
});

test("getThread throws when the thread cannot be resolved", () => {
  const s = Store.open(":memory:");
  assert.throws(() => getThread(s, { messageId: "nope" }), /thread/i);
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mcp && node --import tsx --test test/db-thread.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`db-thread.ts`:

```ts
import type { Store } from "../../mail-mirror/src/store.ts";
import type { MessageSummary } from "./types.ts";

export function getThread(store: Store, ref: { threadId?: number; id?: string; messageId?: string }): MessageSummary[] {
  let threadId = ref.threadId;
  if (threadId == null) {
    const key = ref.messageId ?? ref.id ?? "";
    const r = store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=? AND deleted=0").get(key) as { thread_id: number | null } | undefined;
    if (!r || r.thread_id == null) throw new Error(`Cannot resolve a thread for: ${key}`);
    threadId = r.thread_id;
  }
  const rows = store.raw.prepare(
    `SELECT message_id, subject, from_addr, from_name, date, mailbox, account, snippet, thread_id
     FROM messages WHERE thread_id=? AND deleted=0 ORDER BY date ASC`,
  ).all(threadId) as { message_id: string; subject: string; from_addr: string; from_name: string; date: number; mailbox: string; account: string; snippet: string; thread_id: number | null }[];
  return rows.map((m) => ({
    id: m.message_id,
    messageId: m.message_id,
    subject: m.subject ?? "",
    from: m.from_name ? `${m.from_name} <${m.from_addr}>` : (m.from_addr ?? ""),
    date: new Date(m.date * 1000).toISOString(),
    mailbox: m.mailbox ?? "",
    account: m.account ?? "",
    snippet: m.snippet ?? "",
    threadId: m.thread_id ?? undefined,
  }));
}
```

In `mail.ts`, add the method (import `getThread`):

```ts
  async getThread(args: { threadId?: number; id?: string; messageId?: string }): Promise<MessageSummary[]> {
    return getThread(this.store, args);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mcp && node --import tsx --test test/db-thread.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mcp/src/db-thread.ts apps/mail-mcp/src/mail.ts apps/mail-mcp/test/db-thread.test.ts
git commit -m "feat(mail-mcp): get_thread (DB thread expansion)"
```

---

### Task 6: Tool schemas, descriptions + Mail.search wiring

**Files:**
- Modify: `apps/mail-mcp/src/types.ts` (`SearchArgs`)
- Modify: `apps/mail-mcp/src/mail.ts` (`search` passes the new args through)
- Modify: `apps/mail-mcp/src/index.ts` (search inputSchema, `get_thread` tool registration + dispatch, degrade hint)
- Test: `apps/mail-mcp/test/mail.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 2-5.
- Produces: `SearchArgs` gains `cc`, `senderDomain`, `attachmentType`, `attachmentName`, `minSize`, `maxSize`, `answeredOnly`, `junkOnly`, `anyMailbox`, `sort`, `sortDir`, `fromName`, `fromAddr`, `toName`, `subjectContains`, `bodyContains`. `Mail.search` forwards them all to `SearchDbArgs`. `index.ts` registers `get_thread` and advertises the new params; `unreadOnly`/`flaggedOnly` lose the "(not yet populated)" caveat; `account` documents email/name; `mailbox` documents role keywords.

- [ ] **Step 1: Write the failing test**

```ts
// add to apps/mail-mcp/test/mail.test.ts
test("search forwards field-scoped + rich filters to the DB layer", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("id1", "Invoice", "body"));
  // give it a recipient name to match toName
  s.raw.prepare("UPDATE messages SET to_names=? WHERE message_id='id1'").run(JSON.stringify(["Cristiana Rossi"]));
  s.upsertMessage(row("id2", "Other", "body"));
  const mail = new Mail({ store: s });
  const rows = await mail.search({ toName: "ristian" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, "id1");
  s.close();
});

test("getThread returns the conversation", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a", "S", "b"));
  s.upsertMessage(row("c", "S", "b"));
  s.setThreadId("a", 3); s.setThreadId("c", 3);
  const mail = new Mail({ store: s });
  const out = await mail.getThread({ messageId: "a" });
  assert.equal(out.length, 2);
  s.close();
});
```

> The existing `row()` helper in `mail.test.ts` must be updated to include the new required `MessageRow` fields (`toNames: [], ccNames: [], unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null`) — without that, the file will not type-check after Plan A. Update it as part of Step 3. After updating it, re-call `s.raw.prepare(...)` only where the test needs a value the helper does not set.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-mcp && node --import tsx --test test/mail.test.ts`
Expected: FAIL (`toName`/`getThread` not handled; possibly type errors on `row()`).

- [ ] **Step 3: Implement**

In `types.ts`, extend `SearchArgs`:

```ts
export interface SearchArgs {
  query?: string;
  subject?: string;
  sender?: string;
  recipient?: string;
  cc?: string;
  senderDomain?: string;
  account?: string;
  mailbox?: string;
  anyMailbox?: boolean;
  dateFrom?: string;
  dateTo?: string;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  answeredOnly?: boolean;
  junkOnly?: boolean;
  hasAttachments?: boolean;
  attachmentType?: string;
  attachmentName?: string;
  minSize?: number;
  maxSize?: number;
  fromName?: string;
  fromAddr?: string;
  toName?: string;
  subjectContains?: string;
  bodyContains?: string;
  sort?: "date" | "size";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
```

In `mail.ts` `search`, forward all new fields into `dbArgs` (add each as `field: args.field`), keeping the existing `toEpochSeconds` conversion for dates.

In `index.ts`:
- Extend the `search_messages` inputSchema `properties` with the new params (types: strings for the substring/text ones, booleans for `answeredOnly`/`junkOnly`/`anyMailbox`, numbers for `minSize`/`maxSize`, enums for `sort`/`sortDir`). Update `account` description to "account email, name, or UUID"; `mailbox` to "mailbox name or role keyword (inbox, drafts, sent, trash, junk, archive, important, flagged); use anyMailbox to match a message in ANY of its mailboxes". Remove the "(not yet populated by the mirror)" text from `unreadOnly`/`flaggedOnly`.
- Register a `get_thread` tool:

```ts
    {
      name: "get_thread",
      description: "Return every message in a conversation, oldest first. Pass a threadId from a search result, or a message id/messageId.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "number" },
          id: { type: "string", description: "Mail native id from a search result" },
          messageId: { type: "string", description: "RFC Message-ID" },
        },
        additionalProperties: false,
      },
    },
```
- Add the dispatch case:

```ts
      case "get_thread": {
        const check = dbEmptyCheck();
        if (check.empty) return text({ error: check.message });
        return text(await mail.getThread(args as { threadId?: number; id?: string; messageId?: string }));
      }
```
- Degrade hint: after `if (dbReady) store.enableVectors();`, compute `const enriched = dbReady && enrichmentReady(store);` (import `enrichmentReady`). In `dbEmptyCheck` (or a sibling note), when `dbReady && !enriched`, the new params still won't error (the columns exist on any migrated DB; a non-migrated DB simply lacks them). To keep it safe, gate the advanced behaviour: pass `enriched` into nothing destructive — `buildFilterSql`/`searchTrig` are only reached when the columns exist. Since `mail-mcp` always opens a DB the mirror wrote, and the mirror self-migrates on its next run, document in the `search_messages` description: "Advanced filters require `mail-mirror migrate` to have run once." Do NOT add runtime column-existence branching beyond the probe — keep it simple.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-mcp && node --import tsx --test test/mail.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck, then commit**

Run: `cd apps/mail-mcp && npm test && npm run typecheck`
Expected: green; types clean.

```bash
git add apps/mail-mcp/src/types.ts apps/mail-mcp/src/mail.ts apps/mail-mcp/src/index.ts apps/mail-mcp/test/mail.test.ts
git commit -m "feat(mail-mcp): advertise advanced filters + get_thread; wire search args"
```

---

## Self-Review

**Spec coverage (Plan B B1–B5):**
- B1 account+mailbox filters (friendly email, role keyword, match-any) → Task 3 (resolver) + Task 2 (mailboxNames/anyMailbox SQL). ✅
- B2 flag + rich filters (answered/junk/cc/senderDomain/attachmentType/Name/size/sort) → Task 2 (filters) + Task 3 (sort). ✅
- B3 field-scoped trigram params → Task 4. ✅
- B4 get_thread → Task 5. ✅
- B5 tool schema/descriptions, drop "(not yet populated)", document email/role → Task 6. ✅
- Read-only safety / capability probe → Task 1 + Task 6 documentation. ✅

**Placeholder scan:** none. The only narrative guidance (Task 4 `deleted` note, Task 6 `row()` helper update) gives exact instructions.

**Type consistency:** `DbFilters` fields added in Task 2 are consumed by Task 3's resolver output and Task 6's forwarding; `SearchDbArgs` extended in Task 3 (sort) and Task 4 (trigram params), forwarded by Task 6; `MessageSummary` shape reused identically in Task 5's `getThread`; `searchTrig` signature matches Plan A. `resolveScope` output keys (`account`, `mailboxNames`, `anyMailbox`) match `DbFilters`. ✅

**Handoff note honoured:** Task 1's `enrichmentReady` is the schema-capability probe the Plan A final review asked Plan B to add.
