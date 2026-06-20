# Mail → Wiki Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `apps/mail-promoter` that distils durable-personal-knowledge emails into wiki notes via a tiered cascade (rules → classify on a `local-*` gateway model → distill on a `sub-*` model → `add_source` with a `message://` back-link), idempotent by Message-ID, plus an evaluation harness to pick the models.

**Architecture:** Read the mirror read-only; all LLM/wiki I/O is injected so units test without the network. Reuse the gateway endpoint + its `extractJson`, the wiki mcp-server's `LlmWikiApiClient`, and the mirror's `Store`. A separate SQLite DB holds promotion state.

**Tech Stack:** TypeScript (ESM, `tsx`, `node:test`), better-sqlite3, the LLM gateway (OpenAI-compatible), the LLM Wiki HTTP API.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-20-mail-wiki-promotion-design.md`.
- Read the mirror via `Store.openReadonly` — NEVER write the mirror DB. The promoter owns a SEPARATE state DB.
- Reuse, do not reimplement: the gateway endpoint (no new LLM client beyond a thin fetch wrapper), the gateway's `extractJson` (`apps/llm-gateway/src/extract-json.ts`), the wiki `LlmWikiApiClient` (`apps/llm-wiki/mcp-server/src/api-client.ts`), the mirror `Store`/`MessageRow` (`apps/mail-mirror/src/store.ts`).
- ALL LLM and wiki I/O is INJECTED (a function/client parameter) so unit tests never hit the network; the gateway/wiki being down must degrade gracefully (return null / skip), never crash a batch.
- Concrete model IDs are gateway CONFIGURATION (env), never hardcoded in logic.
- No raw-body copy into the wiki — the note is derived; idempotent by Message-ID (re-promotion overwrites by stable filename + skip-by-hash).
- The note's frontmatter carries `message://<Message-ID>` + from/date/subject/account/categories.
- Tests: from `apps/mail-promoter`, `node --import tsx --test "test/**/*.test.ts"`. Keep `tsc --noEmit` clean. Touch no other package's logic. Do not point the wiki test gate (90/90) at anything.
- Cross-workspace `.ts` imports are the repo convention (e.g. mail-mcp imports `../../mail-mirror/src/store.ts`).

---

### Task 1: Package scaffold + promotion state DB

**Files:**
- Create: `apps/mail-promoter/package.json`, `apps/mail-promoter/tsconfig.json`
- Create: `apps/mail-promoter/src/state.ts`
- Create: `apps/mail-promoter/src/paths.ts`
- Test: `apps/mail-promoter/test/state.test.ts`

**Interfaces:**
- Produces: `paths.ts` → `stateDbPath(): string` (under `~/Library/Application Support/mail-promoter/state.db`). `state.ts` → `class PromoteState` with `static open(path): PromoteState`, `needsProcessing(messageId: string, sourceHash: string): boolean` (true if no row OR stored `source_hash` differs), `record(r: { messageId: string; decision: "promoted" | "skipped"; categories: string[]; classifyModel: string; distillModel: string | null; wikiFilename: string | null; sourceHash: string }): void`, `get(messageId): { decision: string; sourceHash: string } | undefined`, `close()`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-promoter/test/state.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { PromoteState } from "../src/state.ts";

test("needsProcessing: true when unseen, false after record with same hash, true after hash change", () => {
  const s = PromoteState.open(":memory:");
  assert.equal(s.needsProcessing("m1", "h1"), true);
  s.record({ messageId: "m1", decision: "skipped", categories: [], classifyModel: "local-chat", distillModel: null, wikiFilename: null, sourceHash: "h1" });
  assert.equal(s.needsProcessing("m1", "h1"), false);
  assert.equal(s.needsProcessing("m1", "h2"), true);
  s.close();
});

test("record stores a promotion and get returns the decision + hash", () => {
  const s = PromoteState.open(":memory:");
  s.record({ messageId: "m2", decision: "promoted", categories: ["commitment"], classifyModel: "local-chat", distillModel: "sub-opus", wikiFilename: "mail-m2.md", sourceHash: "hh" });
  assert.deepEqual(s.get("m2"), { decision: "promoted", sourceHash: "hh" });
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-promoter && node --import tsx --test test/state.test.ts`
Expected: FAIL (module not found). (If the new workspace's deps aren't linked, run `npm install` at the repo root.)

- [ ] **Step 3: Implement scaffold + state**

`apps/mail-promoter/package.json`:

```json
{
  "name": "@llm-wiki/mail-promoter",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "mail-promoter": "src/cli.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

`apps/mail-promoter/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noUnusedLocals": true, "esModuleInterop": true,
    "skipLibCheck": true, "types": ["node"], "allowImportingTsExtensions": true, "noEmit": true
  },
  "include": ["src", "test"]
}
```

`apps/mail-promoter/src/paths.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function stateDbPath(): string {
  const dir = join(homedir(), "Library", "Application Support", "mail-promoter");
  mkdirSync(dir, { recursive: true });
  return join(dir, "state.db");
}
```

`apps/mail-promoter/src/state.ts`:

```ts
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS promote_state (
  message_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  categories TEXT,
  classify_model TEXT,
  distill_model TEXT,
  wiki_filename TEXT,
  source_hash TEXT,
  promoted_at INTEGER
);`;

export interface PromoteRecord {
  messageId: string;
  decision: "promoted" | "skipped";
  categories: string[];
  classifyModel: string;
  distillModel: string | null;
  wikiFilename: string | null;
  sourceHash: string;
}

export class PromoteState {
  private constructor(private db: Database.Database) {}

  static open(path: string): PromoteState {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return new PromoteState(db);
  }

  needsProcessing(messageId: string, sourceHash: string): boolean {
    const r = this.db.prepare("SELECT source_hash FROM promote_state WHERE message_id=?").get(messageId) as { source_hash: string } | undefined;
    return !r || r.source_hash !== sourceHash;
  }

  get(messageId: string): { decision: string; sourceHash: string } | undefined {
    const r = this.db.prepare("SELECT decision, source_hash FROM promote_state WHERE message_id=?").get(messageId) as { decision: string; source_hash: string } | undefined;
    return r ? { decision: r.decision, sourceHash: r.source_hash } : undefined;
  }

  record(r: PromoteRecord): void {
    this.db.prepare(
      `INSERT INTO promote_state (message_id, decision, categories, classify_model, distill_model, wiki_filename, source_hash, promoted_at)
       VALUES (@message_id,@decision,@categories,@classify_model,@distill_model,@wiki_filename,@source_hash,@now)
       ON CONFLICT(message_id) DO UPDATE SET decision=excluded.decision, categories=excluded.categories,
         classify_model=excluded.classify_model, distill_model=excluded.distill_model,
         wiki_filename=excluded.wiki_filename, source_hash=excluded.source_hash, promoted_at=excluded.promoted_at`,
    ).run({
      message_id: r.messageId, decision: r.decision, categories: JSON.stringify(r.categories),
      classify_model: r.classifyModel, distill_model: r.distillModel, wiki_filename: r.wikiFilename,
      source_hash: r.sourceHash, now: Math.floor(Date.now() / 1000),
    });
  }

  close(): void { this.db.close(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-promoter && node --import tsx --test test/state.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-promoter/package.json apps/mail-promoter/tsconfig.json apps/mail-promoter/src/paths.ts apps/mail-promoter/src/state.ts apps/mail-promoter/test/state.test.ts
git commit -m "feat(mail-promoter): scaffold + promote_state DB (idempotency)"
```

---

### Task 2: Deterministic prefilter

**Files:**
- Create: `apps/mail-promoter/src/prefilter.ts`
- Test: `apps/mail-promoter/test/prefilter.test.ts`

**Interfaces:**
- Consumes: a minimal message shape `{ fromAddr: string; subject: string; bodyState: string }` and an optional resolved mailbox `role?: string`.
- Produces: `shouldConsider(msg: { fromAddr: string; subject: string; bodyState: string }, role?: string): boolean` — false (drop) when role ∈ {junk, spam, bulk}, when the sender local matches a noise pattern (`noreply`, `no-reply`, `notifications`, `mailer`, `newsletter`, `donotreply`, `no_reply`), when the subject looks like an OTP / verification code, or when `bodyState === "none"`. True otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-promoter/test/prefilter.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldConsider } from "../src/prefilter.ts";

const base = { fromAddr: "anna@friend.com", subject: "Lunch next week?", bodyState: "full" };

test("keeps an ordinary personal email", () => {
  assert.equal(shouldConsider(base), true);
});

test("drops junk/spam/bulk by mailbox role", () => {
  assert.equal(shouldConsider(base, "junk"), false);
  assert.equal(shouldConsider(base, "spam"), false);
  assert.equal(shouldConsider(base, "bulk"), false);
  assert.equal(shouldConsider(base, "inbox"), true);
});

test("drops no-reply / notification / newsletter senders", () => {
  for (const a of ["noreply@x.com", "no-reply@x.com", "notifications@x.com", "newsletter@x.com", "mailer@x.com"]) {
    assert.equal(shouldConsider({ ...base, fromAddr: a }), false, a);
  }
});

test("drops OTP / verification-code subjects", () => {
  assert.equal(shouldConsider({ ...base, subject: "Your verification code is 384921" }), false);
  assert.equal(shouldConsider({ ...base, subject: "123456 is your one-time code" }), false);
});

test("drops empty-bodied (none) messages", () => {
  assert.equal(shouldConsider({ ...base, bodyState: "none" }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-promoter && node --import tsx --test test/prefilter.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/mail-promoter/src/prefilter.ts
const NOISE_ROLES = new Set(["junk", "spam", "bulk"]);
const NOISE_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer|newsletter|bounce|postmaster)\b/i;
const OTP_SUBJECT = /\b(verification|one[-\s]?time|security|login|access)\s+code\b|\bOTP\b|\bcodice\b|\b\d{4,8}\s+is your\b|\bis your.*code\b/i;

/** Deterministic noise drop using only what the mirror stores. true = worth classifying. */
export function shouldConsider(msg: { fromAddr: string; subject: string; bodyState: string }, role?: string): boolean {
  if (role && NOISE_ROLES.has(role)) return false;
  if (msg.bodyState === "none") return false;
  const local = (msg.fromAddr || "").split("@")[0] ?? "";
  if (NOISE_SENDER.test(local)) return false;
  if (OTP_SUBJECT.test(msg.subject || "")) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-promoter && node --import tsx --test test/prefilter.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-promoter/src/prefilter.ts apps/mail-promoter/test/prefilter.test.ts
git commit -m "feat(mail-promoter): deterministic prefilter (role/sender/subject/body)"
```

---

### Task 3: Note builder (frontmatter + `message://` + stable filename)

**Files:**
- Create: `apps/mail-promoter/src/note.ts`
- Test: `apps/mail-promoter/test/note.test.ts`

**Interfaces:**
- Consumes: a message `{ messageId; fromName; fromAddr; subject; date; account }`, a resolved account label (email/name string), and a `DistilledNote { summary: string; facts: string[]; commitments: string[]; people: string[]; orgs: string[] }`, plus `categories: string[]`.
- Produces: `slugForMessageId(messageId: string): string` (a filesystem-safe stable slug → `mail-<slug>.md`); `buildNote(args: { msg; accountLabel: string; distilled: DistilledNote; categories: string[] }): { filename: string; content: string }` — YAML frontmatter with `source: message://<messageId>`, `subject`, `from`, `date` (ISO), `account`, `categories`, then a markdown body (summary + bulleted facts / commitments / people / orgs, omitting empty sections).

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-promoter/test/note.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNote, slugForMessageId } from "../src/note.ts";

const msg = { messageId: "abc@mail.example", fromName: "Anna", fromAddr: "anna@x.com", subject: "Detrazione", date: 1750000000, account: "ACC" };
const distilled = { summary: "Anna chiede i certificati per la detrazione.", facts: ["scadenza 30 giugno"], commitments: ["inviare certificati"], people: ["Anna"], orgs: [] };

test("slug is stable and filesystem-safe", () => {
  const a = slugForMessageId("abc@mail.example");
  assert.equal(a, slugForMessageId("abc@mail.example"));
  assert.match(a, /^[a-z0-9-]+$/);
});

test("note has frontmatter with the message:// link and the distilled body", () => {
  const { filename, content } = buildNote({ msg, accountLabel: "biz@x.com", distilled, categories: ["commitment", "document"] });
  assert.match(filename, /^mail-.*\.md$/);
  assert.match(content, /^---\n/);
  assert.match(content, /source: message:\/\/abc@mail\.example/);
  assert.match(content, /subject: Detrazione/);
  assert.match(content, /account: biz@x\.com/);
  assert.match(content, /categories: \[commitment, document\]/);
  assert.match(content, /Anna chiede i certificati/);
  assert.match(content, /- inviare certificati/);
  assert.doesNotMatch(content, /## Organizations/); // empty section omitted
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-promoter && node --import tsx --test test/note.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/mail-promoter/src/note.ts
export interface DistilledNote {
  summary: string;
  facts: string[];
  commitments: string[];
  people: string[];
  orgs: string[];
}

export function slugForMessageId(messageId: string): string {
  const s = messageId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 80) || "msg";
}

function section(title: string, items: string[]): string {
  if (!items.length) return "";
  return `\n## ${title}\n${items.map((i) => `- ${i}`).join("\n")}\n`;
}

export function buildNote(args: {
  msg: { messageId: string; fromName: string; fromAddr: string; subject: string; date: number; account: string };
  accountLabel: string;
  distilled: DistilledNote;
  categories: string[];
}): { filename: string; content: string } {
  const { msg, accountLabel, distilled, categories } = args;
  const from = msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr;
  const fm = [
    "---",
    `source: message://${msg.messageId}`,
    `subject: ${msg.subject}`,
    `from: ${from}`,
    `date: ${new Date(msg.date * 1000).toISOString()}`,
    `account: ${accountLabel}`,
    `categories: [${categories.join(", ")}]`,
    "---",
    "",
  ].join("\n");
  const body =
    `${distilled.summary}\n` +
    section("Facts", distilled.facts) +
    section("Commitments", distilled.commitments) +
    section("People", distilled.people) +
    section("Organizations", distilled.orgs);
  return { filename: `mail-${slugForMessageId(msg.messageId)}.md`, content: fm + body };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-promoter && node --import tsx --test test/note.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-promoter/src/note.ts apps/mail-promoter/test/note.test.ts
git commit -m "feat(mail-promoter): note builder (frontmatter + message:// + stable slug)"
```

---

### Task 4: LLM client + classify + distill

**Files:**
- Create: `apps/mail-promoter/src/llm.ts`
- Create: `apps/mail-promoter/src/classify.ts`
- Create: `apps/mail-promoter/src/distill.ts`
- Test: `apps/mail-promoter/test/classify.test.ts`, `apps/mail-promoter/test/distill.test.ts`

**Interfaces:**
- Consumes: the gateway's `extractJson` (`../../llm-gateway/src/extract-json.ts`); `DistilledNote` (Task 3).
- Produces:
  - `llm.ts`: `type Chat = (system: string, user: string) => Promise<string>`; `gatewayChat(cfg: { endpoint: string; model: string; apiKey?: string }, fetchImpl?): Chat` — POSTs an OpenAI chat completion, returns `choices[0].message.content` (throws on non-ok / network error).
  - `classify.ts`: `classify(msg: { fromName: string; fromAddr: string; subject: string; bodyText: string }, chat: Chat): Promise<{ promote: boolean; categories: string[] } | null>` — prompts for strict JSON `{promote: boolean, categories: string[]}` with categories from {commitment, document, personal-fact, decision, relationship}; parses with `extractJson`; returns `null` on any chat/parse error (best-effort).
  - `distill.ts`: `distill(msg, chat: Chat): Promise<DistilledNote | null>` — prompts for JSON `{summary, facts[], commitments[], people[], orgs[]}`; parses with `extractJson`; `null` on error.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/mail-promoter/test/classify.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../src/classify.ts";

const msg = { fromName: "Anna", fromAddr: "anna@x.com", subject: "Certificati", bodyText: "Mi servono i certificati entro venerdì." };

test("classify parses a fenced JSON verdict", async () => {
  const chat = async () => '```json\n{"promote": true, "categories": ["commitment", "document"]}\n```';
  assert.deepEqual(await classify(msg, chat), { promote: true, categories: ["commitment", "document"] });
});

test("classify returns null when the model errors", async () => {
  const chat = async () => { throw new Error("gateway down"); };
  assert.equal(await classify(msg, chat), null);
});

test("classify returns null on unparseable output", async () => {
  const chat = async () => "I cannot answer that.";
  assert.equal(await classify(msg, chat), null);
});
```

```ts
// apps/mail-promoter/test/distill.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { distill } from "../src/distill.ts";

const msg = { fromName: "Anna", fromAddr: "anna@x.com", subject: "Certificati", bodyText: "Mi servono i certificati entro venerdì." };

test("distill parses a JSON note", async () => {
  const chat = async () => '{"summary":"Anna chiede certificati","facts":["entro venerdì"],"commitments":["inviare certificati"],"people":["Anna"],"orgs":[]}';
  const r = await distill(msg, chat);
  assert.equal(r?.summary, "Anna chiede certificati");
  assert.deepEqual(r?.commitments, ["inviare certificati"]);
});

test("distill returns null on error", async () => {
  assert.equal(await distill(msg, async () => { throw new Error("x"); }), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mail-promoter && node --import tsx --test test/classify.test.ts test/distill.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`apps/mail-promoter/src/llm.ts`:

```ts
export type Chat = (system: string, user: string) => Promise<string>;

/** Build an OpenAI-compatible chat function over the gateway (or any OpenAI endpoint). */
export function gatewayChat(cfg: { endpoint: string; model: string; apiKey?: string }, fetchImpl: typeof fetch = fetch): Chat {
  return async (system, user) => {
    const res = await fetchImpl(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`gateway chat ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  };
}
```

`apps/mail-promoter/src/classify.ts`:

```ts
import { extractJson } from "../../llm-gateway/src/extract-json.ts";
import type { Chat } from "./llm.ts";

const CATEGORIES = ["commitment", "document", "personal-fact", "decision", "relationship"];
const SYSTEM =
  `You decide whether an email holds DURABLE PERSONAL KNOWLEDGE worth saving to long-term memory ` +
  `(requests/commitments, important documents, personal facts, decisions, relationships) vs noise ` +
  `(marketing, notifications, one-off transactional). Reply with ONLY JSON: ` +
  `{"promote": boolean, "categories": string[]} where categories ⊆ ${JSON.stringify(CATEGORIES)}.`;

export async function classify(
  msg: { fromName: string; fromAddr: string; subject: string; bodyText: string },
  chat: Chat,
): Promise<{ promote: boolean; categories: string[] } | null> {
  const user = `From: ${msg.fromName} <${msg.fromAddr}>\nSubject: ${msg.subject}\n\n${msg.bodyText.slice(0, 4000)}`;
  try {
    const out = (await chat(SYSTEM, user)) as string;
    const parsed = extractJson(out) as { promote?: unknown; categories?: unknown };
    if (typeof parsed.promote !== "boolean") return null;
    const cats = Array.isArray(parsed.categories) ? parsed.categories.filter((c): c is string => typeof c === "string" && CATEGORIES.includes(c)) : [];
    return { promote: parsed.promote, categories: cats };
  } catch {
    return null;
  }
}
```

`apps/mail-promoter/src/distill.ts`:

```ts
import { extractJson } from "../../llm-gateway/src/extract-json.ts";
import type { DistilledNote } from "./note.ts";
import type { Chat } from "./llm.ts";

const SYSTEM =
  `Distil an email into durable memory. Reply with ONLY JSON: ` +
  `{"summary": string, "facts": string[], "commitments": string[], "people": string[], "orgs": string[]}. ` +
  `summary: 1-3 sentences. facts: concrete durable facts. commitments: requests/promises (who owes what). ` +
  `people/orgs: named entities. Keep it faithful; do not invent.`;

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function distill(
  msg: { fromName: string; fromAddr: string; subject: string; bodyText: string },
  chat: Chat,
): Promise<DistilledNote | null> {
  const user = `From: ${msg.fromName} <${msg.fromAddr}>\nSubject: ${msg.subject}\n\n${msg.bodyText.slice(0, 8000)}`;
  try {
    const out = (await chat(SYSTEM, user)) as string;
    const p = extractJson(out) as Record<string, unknown>;
    if (typeof p.summary !== "string" || !p.summary.trim()) return null;
    return { summary: p.summary, facts: strs(p.facts), commitments: strs(p.commitments), people: strs(p.people), orgs: strs(p.orgs) };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mail-promoter && node --import tsx --test test/classify.test.ts test/distill.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-promoter/src/llm.ts apps/mail-promoter/src/classify.ts apps/mail-promoter/src/distill.ts apps/mail-promoter/test/classify.test.ts apps/mail-promoter/test/distill.test.ts
git commit -m "feat(mail-promoter): gateway chat + classify + distill (extractJson)"
```

---

### Task 5: Wiki promotion adapter

**Files:**
- Create: `apps/mail-promoter/src/wiki.ts`
- Test: `apps/mail-promoter/test/wiki.test.ts`

**Interfaces:**
- Consumes: the wiki `LlmWikiApiClient` (`../../llm-wiki/mcp-server/src/api-client.ts`, method `addSources(projectId, sources, rescan)`); `note` from Task 3.
- Produces: `interface WikiPromoter { addSources(projectId: string, sources: { filename: string; content: string }[], rescan?: boolean): Promise<unknown> }` (the structural slice of `LlmWikiApiClient` we use); `promote(note: { filename: string; content: string }, client: WikiPromoter, projectId?: string): Promise<void>` — calls `client.addSources(projectId ?? "current", [note], true)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-promoter/test/wiki.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { promote } from "../src/wiki.ts";

test("promote calls addSources with the note and default project", async () => {
  const calls: unknown[] = [];
  const client = { addSources: async (p: string, s: unknown, r?: boolean) => { calls.push([p, s, r]); return {}; } };
  await promote({ filename: "mail-x.md", content: "hi" }, client);
  assert.deepEqual(calls, [["current", [{ filename: "mail-x.md", content: "hi" }], true]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-promoter && node --import tsx --test test/wiki.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/mail-promoter/src/wiki.ts
export interface WikiPromoter {
  addSources(projectId: string, sources: { filename: string; content: string }[], rescan?: boolean): Promise<unknown>;
}

/** Add a distilled note to the wiki as a source. `LlmWikiApiClient` from the wiki mcp-server satisfies WikiPromoter. */
export async function promote(note: { filename: string; content: string }, client: WikiPromoter, projectId = "current"): Promise<void> {
  await client.addSources(projectId, [note], true);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-promoter && node --import tsx --test test/wiki.test.ts && npx tsc --noEmit`
Expected: PASS (1 test); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-promoter/src/wiki.ts apps/mail-promoter/test/wiki.test.ts
git commit -m "feat(mail-promoter): wiki promotion adapter (add_source)"
```

---

### Task 6: Orchestrator + CLI

**Files:**
- Create: `apps/mail-promoter/src/run.ts`
- Create: `apps/mail-promoter/src/config.ts`
- Create: `apps/mail-promoter/src/cli.ts`
- Test: `apps/mail-promoter/test/run.test.ts`

**Interfaces:**
- Consumes: `PromoteState` (T1), `shouldConsider` (T2), `buildNote` (T3), `classify`/`distill`/`Chat` (T4), `promote`/`WikiPromoter` (T5), the mirror `Store` (`../../mail-mirror/src/store.ts`).
- Produces:
  - `config.ts`: `loadConfig(env)` → `{ llmEndpoint: string; classifyModel: string; distillModel: string; apiKey?: string }` from `MAIL_PROMOTER_LLM_ENDPOINT` (default `http://127.0.0.1:4000/v1/chat/completions`), `MAIL_PROMOTER_CLASSIFY_MODEL` (default `local-chat`), `MAIL_PROMOTER_DISTILL_MODEL` (default `sub-opus`), `MAIL_PROMOTER_LLM_API_KEY`.
  - `run.ts`: `sourceHash(msg): string` (sha256 of subject+body); `processOne(deps, msg): Promise<"promoted" | "skipped" | "filtered" | "deferred">` and `runBatch(deps, opts: { limit?: number }): Promise<{ promoted: number; skipped: number; filtered: number; deferred: number }>`, where `deps = { store: Store; state: PromoteState; classifyChat: Chat; distillChat: Chat; wiki: WikiPromoter; roleOf: (account: string, mailbox: string) => string | undefined; accountLabelOf: (account: string) => string }`. `processOne`: skip-by-state → prefilter (filtered) → classify (deferred if null) → if promote: distill (deferred if null) → buildNote → promote → state.record; else state.record skipped.
  - `cli.ts`: `mail-promoter <backfill|status>`; `backfill` wires the real `Store.openReadonly`, `gatewayChat`, `LlmWikiApiClient`, and iterates messages recent-first.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-promoter/test/run.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../mail-mirror/src/store.ts";
import { PromoteState } from "../src/state.ts";
import { processOne, type RunDeps } from "../src/run.ts";

function row(over = {}) {
  return {
    messageId: "m1", account: "ACC", mailbox: "INBOX", fromName: "Anna", fromAddr: "anna@x.com",
    to: [], cc: [], toNames: [], ccNames: [], subject: "Certificati", date: 1750000000,
    bodyText: "Mi servono i certificati entro venerdì.", bodyState: "full" as const, source: "emlx" as const,
    emlxPath: null, inReplyTo: null, references: [], gmThrid: null, size: 1, unread: false, flagged: false,
    answered: false, junk: false, flagColor: null, appleThrid: null, ...over,
  };
}

function deps(over: Partial<RunDeps> = {}): RunDeps {
  const store = Store.open(":memory:");
  store.upsertMessage(row());
  return {
    store, state: PromoteState.open(":memory:"),
    classifyChat: async () => '{"promote": true, "categories": ["commitment"]}',
    distillChat: async () => '{"summary":"s","facts":[],"commitments":["inviare"],"people":["Anna"],"orgs":[]}',
    wiki: { addSources: async () => ({}) },
    roleOf: () => "inbox", accountLabelOf: () => "biz@x.com", ...over,
  };
}

test("processOne promotes a durable mail and records state", async () => {
  const d = deps();
  const r = await processOne(d, d.store.getMessage("m1")!);
  assert.equal(r, "promoted");
  assert.equal(d.state.get("m1")?.decision, "promoted");
});

test("processOne filters a junk-role mail without calling the LLM", async () => {
  let called = false;
  const d = deps({ roleOf: () => "junk", classifyChat: async () => { called = true; return "{}"; } });
  const r = await processOne(d, d.store.getMessage("m1")!);
  assert.equal(r, "filtered");
  assert.equal(called, false);
});

test("processOne defers (no state) when the classifier is unavailable", async () => {
  const d = deps({ classifyChat: async () => { throw new Error("down"); } });
  const r = await processOne(d, d.store.getMessage("m1")!);
  assert.equal(r, "deferred");
  assert.equal(d.state.get("m1"), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-promoter && node --import tsx --test test/run.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`apps/mail-promoter/src/config.ts`:

```ts
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    llmEndpoint: env.MAIL_PROMOTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions",
    classifyModel: env.MAIL_PROMOTER_CLASSIFY_MODEL ?? "local-chat",
    distillModel: env.MAIL_PROMOTER_DISTILL_MODEL ?? "sub-opus",
    apiKey: env.MAIL_PROMOTER_LLM_API_KEY,
  };
}
```

`apps/mail-promoter/src/run.ts`:

```ts
import { createHash } from "node:crypto";
import type { Store, MessageRow } from "../../mail-mirror/src/store.ts";
import type { PromoteState } from "./state.ts";
import type { Chat } from "./llm.ts";
import type { WikiPromoter } from "./wiki.ts";
import { shouldConsider } from "./prefilter.ts";
import { classify } from "./classify.ts";
import { distill } from "./distill.ts";
import { buildNote } from "./note.ts";
import { promote } from "./wiki.ts";

export interface RunDeps {
  store: Store;
  state: PromoteState;
  classifyChat: Chat;
  distillChat: Chat;
  wiki: WikiPromoter;
  roleOf: (account: string, mailbox: string) => string | undefined;
  accountLabelOf: (account: string) => string;
  classifyModel?: string;
  distillModel?: string;
}

export function sourceHash(msg: { subject: string; bodyText: string }): string {
  return createHash("sha256").update(`${msg.subject}\n${msg.bodyText}`).digest("hex");
}

export async function processOne(deps: RunDeps, msg: MessageRow): Promise<"promoted" | "skipped" | "filtered" | "deferred"> {
  const hash = sourceHash(msg);
  if (!deps.state.needsProcessing(msg.messageId, hash)) return "skipped";
  if (!shouldConsider({ fromAddr: msg.fromAddr, subject: msg.subject, bodyState: msg.bodyState }, deps.roleOf(msg.account, msg.mailbox))) {
    return "filtered";
  }
  const verdict = await classify(msg, deps.classifyChat);
  if (!verdict) return "deferred"; // LLM unavailable / unparseable — retry next run, no state
  const classifyModel = deps.classifyModel ?? "local-chat";
  if (!verdict.promote) {
    deps.state.record({ messageId: msg.messageId, decision: "skipped", categories: verdict.categories, classifyModel, distillModel: null, wikiFilename: null, sourceHash: hash });
    return "skipped";
  }
  const distilled = await distill(msg, deps.distillChat);
  if (!distilled) return "deferred";
  const note = buildNote({ msg, accountLabel: deps.accountLabelOf(msg.account), distilled, categories: verdict.categories });
  await promote(note, deps.wiki);
  deps.state.record({ messageId: msg.messageId, decision: "promoted", categories: verdict.categories, classifyModel, distillModel: deps.distillModel ?? "sub-opus", wikiFilename: note.filename, sourceHash: hash });
  return "promoted";
}

export async function runBatch(deps: RunDeps, opts: { limit?: number } = {}): Promise<{ promoted: number; skipped: number; filtered: number; deferred: number }> {
  const limit = opts.limit ?? 100000;
  const ids = (deps.store.raw.prepare("SELECT message_id FROM messages WHERE deleted=0 ORDER BY date DESC LIMIT ?").all(limit) as { message_id: string }[]).map((r) => r.message_id);
  const tally = { promoted: 0, skipped: 0, filtered: 0, deferred: 0 };
  for (const id of ids) {
    const msg = deps.store.getMessage(id);
    if (!msg) continue;
    try {
      tally[await processOne(deps, msg)]++;
    } catch {
      tally.deferred++; // wiki/other error — leave for retry
    }
  }
  return tally;
}
```

`apps/mail-promoter/src/cli.ts`:

```ts
#!/usr/bin/env -S node --import tsx
import { fileURLToPath } from "node:url";
import { Store } from "../../mail-mirror/src/store.ts";
import { dbPath } from "../../mail-mirror/src/paths.ts";
import { LlmWikiApiClient } from "../../llm-wiki/mcp-server/src/api-client.ts";
import { PromoteState } from "./state.ts";
import { stateDbPath } from "./paths.ts";
import { loadConfig } from "./config.ts";
import { gatewayChat } from "./llm.ts";
import { runBatch, type RunDeps } from "./run.ts";

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const cfg = loadConfig();
  const store = Store.openReadonly(dbPath());
  store.enableVectors();
  const state = PromoteState.open(stateDbPath());
  const wiki = new LlmWikiApiClient({ baseUrl: process.env.LLM_WIKI_API_BASE_URL });
  const deps: RunDeps = {
    store, state, wiki,
    classifyChat: gatewayChat({ endpoint: cfg.llmEndpoint, model: cfg.classifyModel, apiKey: cfg.apiKey }),
    distillChat: gatewayChat({ endpoint: cfg.llmEndpoint, model: cfg.distillModel, apiKey: cfg.apiKey }),
    roleOf: (a, m) => store.roleForMailbox(a, m),
    accountLabelOf: (a) => (store.raw.prepare("SELECT emails FROM accounts WHERE uuid=?").get(a) as { emails: string } | undefined)?.emails ?? a,
    classifyModel: cfg.classifyModel, distillModel: cfg.distillModel,
  };
  if (cmd === "backfill") {
    const t = await runBatch(deps);
    console.log(`promote backfill: promoted ${t.promoted}, skipped ${t.skipped}, filtered ${t.filtered}, deferred ${t.deferred}`);
  } else if (cmd === "status") {
    const c = (state as unknown as { db: import("better-sqlite3").Database }).db; void c;
    console.log(`promoter state: ${stateDbPath()}`);
  } else {
    console.log("usage: mail-promoter <backfill|status>");
    process.exit(1);
  }
  state.close();
  store.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

> Note for the implementer: the `status` command's `db` access shown above is illustrative only and reaches a private field; instead expose a `PromoteState.counts(): { promoted: number; skipped: number }` method (a `SELECT decision, COUNT(*) GROUP BY decision`) and print that. Add the method to `state.ts` and use it in `status`. Keep the `state.test.ts` additions minimal (one assertion that counts reflect records).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-promoter && node --import tsx --test test/run.test.ts && node --import tsx --test "test/**/*.test.ts" && npx tsc --noEmit`
Expected: PASS (all); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-promoter/src/config.ts apps/mail-promoter/src/run.ts apps/mail-promoter/src/cli.ts apps/mail-promoter/src/state.ts apps/mail-promoter/test/
git commit -m "feat(mail-promoter): orchestrator + CLI (backfill/status)"
```

---

### Task 7: Evaluation harness

**Files:**
- Create: `apps/mail-promoter/src/eval.ts`
- Modify: `apps/mail-promoter/src/cli.ts` (add an `eval` command)
- Test: `apps/mail-promoter/test/eval.test.ts`

**Interfaces:**
- Consumes: `classify`/`Chat` (T4), `shouldConsider` (T2).
- Produces: `type LabelledItem = { messageId: string; label: "promote" | "skip"; msg: { fromAddr: string; fromName: string; subject: string; bodyText: string; bodyState: string }; role?: string }`; `evaluate(items: LabelledItem[], chat: Chat): Promise<{ tp: number; fp: number; tn: number; fn: number; precision: number; recall: number }>` — runs prefilter+classify per item (a prefilter drop counts as a predicted "skip"), compares to the label, returns the confusion + precision/recall (guarding divide-by-zero → 0).

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail-promoter/test/eval.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, type LabelledItem } from "../src/eval.ts";

const mk = (id: string, label: "promote" | "skip", subject: string): LabelledItem => ({
  messageId: id, label, msg: { fromAddr: "a@x.com", fromName: "A", subject, bodyText: "body", bodyState: "full" },
});

test("evaluate computes precision/recall against labels", async () => {
  const items = [mk("1", "promote", "Certificati"), mk("2", "skip", "Hi"), mk("3", "promote", "Contratto")];
  // model promotes anything whose subject is not "Hi"
  const chat = async (_s: string, user: string) => (user.includes("Hi") ? '{"promote":false,"categories":[]}' : '{"promote":true,"categories":[]}');
  const r = await evaluate(items, chat);
  assert.equal(r.tp, 2); // 1 and 3 promoted correctly
  assert.equal(r.tn, 1); // 2 skipped correctly
  assert.equal(r.fp, 0);
  assert.equal(r.fn, 0);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail-promoter && node --import tsx --test test/eval.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/mail-promoter/src/eval.ts
import { shouldConsider } from "./prefilter.ts";
import { classify } from "./classify.ts";
import type { Chat } from "./llm.ts";

export type LabelledItem = {
  messageId: string;
  label: "promote" | "skip";
  msg: { fromAddr: string; fromName: string; subject: string; bodyText: string; bodyState: string };
  role?: string;
};

export async function evaluate(items: LabelledItem[], chat: Chat): Promise<{ tp: number; fp: number; tn: number; fn: number; precision: number; recall: number }> {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const it of items) {
    let predict: boolean;
    if (!shouldConsider(it.msg, it.role)) {
      predict = false;
    } else {
      const v = await classify(it.msg, chat);
      predict = v?.promote === true;
    }
    const actual = it.label === "promote";
    if (predict && actual) tp++;
    else if (predict && !actual) fp++;
    else if (!predict && !actual) tn++;
    else fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { tp, fp, tn, fn, precision, recall };
}
```

In `cli.ts`, add an `eval` command: read a labelled JSON fixture path from `process.argv[3]` (`{ items: LabelledItem[] }`), build `gatewayChat` for each candidate model in `MAIL_PROMOTER_EVAL_MODELS` (comma-separated, default the configured classify model), call `evaluate`, and print a per-model `precision/recall/tp/fp/tn/fn` line. (No new network in tests — the command is run by a human with the gateway up.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mail-promoter && node --import tsx --test test/eval.test.ts && node --import tsx --test "test/**/*.test.ts" && npx tsc --noEmit`
Expected: PASS (all); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-promoter/src/eval.ts apps/mail-promoter/src/cli.ts apps/mail-promoter/test/eval.test.ts
git commit -m "feat(mail-promoter): evaluation harness (precision/recall over labelled sample)"
```

---

## Self-Review

**Spec coverage:**
- Cascade rules→classify(local)→distill(sub) → Tasks 2, 4, 6. ✅
- Promotion = wiki source via add_source → Task 5; frontmatter + `message://` + slug → Task 3. ✅
- Idempotent by Message-ID, separate state DB, skip-by-hash → Task 1 + Task 6 (`sourceHash`/`needsProcessing`). ✅
- LLM via gateway, endpoint-agnostic, model IDs = config, `extractJson` reused → Task 4 + Task 6 config. ✅
- Read mirror read-only, never write it → Task 6 CLI (`Store.openReadonly`); the promoter writes only its own state DB. ✅
- Best-effort: gateway/wiki down → deferred, no state, retried → Task 6 `processOne`/`runBatch`. ✅
- Evaluation first, manual labels → Task 7. ✅
- Reuse (gateway extractJson, wiki client, mirror Store) → Tasks 4/5/6 imports. ✅

**Placeholder scan:** Model defaults (`local-chat`, `sub-opus`) are gateway config names, not plan-failure TODOs. The Task 6 `status` note explicitly replaces the illustrative private-field access with a `PromoteState.counts()` method — the implementer adds that small method; not a vague step. No other placeholders.

**Type consistency:** `Chat`, `DistilledNote`, `WikiPromoter`, `PromoteState`, `RunDeps`, `LabelledItem`, `sourceHash`, `shouldConsider`, `buildNote`, `classify`, `distill`, `promote` are defined once and consumed with matching signatures across Tasks 4–7. `MessageRow` comes from the mirror `Store`. The wiki client's `addSources(projectId, sources, rescan)` matches `WikiPromoter`. ✅
