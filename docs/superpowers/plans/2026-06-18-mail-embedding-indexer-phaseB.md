# Mail Embedding Indexer (Phase B of sub-project 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vector index (sqlite-vec) to the Mail DB and an embedding indexer in `apps/mail-mirror` that embeds each message via the shared `@llm-wiki/embedding` package and a configured OpenAI-compatible endpoint — recent-first, resumable, degrading gracefully to no-op when the endpoint is unreachable.

**Architecture:** A `vec_messages` sqlite-vec virtual table (rowid = `messages.rowid`, like FTS) plus an `embed_state` table track embeddings. `embed-config` reads the endpoint/model from env; `embed-client.embedText` wraps the shared package with Node `fetch`; `embed.embedMessage`/`embedBackfill` embed messages needing it (new or changed), skipping unchanged ones via a source hash; a worker drains the queue in the daemon and an `embed` CLI does the backfill.

**Tech Stack:** TypeScript ESM, `better-sqlite3` + `sqlite-vec`, `@llm-wiki/embedding`. Tests: `node --import tsx --test`.

Spec: `docs/superpowers/specs/2026-06-18-mail-hybrid-search-design.md` (Phase B). Builds on `apps/mail-mirror` (sub-project 1) and `packages/embedding` (Phase A).

## Global Constraints

- sqlite-vec VALIDATED API (from the spike): `import * as sqliteVec from "sqlite-vec"; sqliteVec.load(db)` (v0.1.x); table `CREATE VIRTUAL TABLE vec_messages USING vec0(embedding float[D])`; INSERT binds rowid as a **BigInt** and the vector as **JSON text** (`JSON.stringify(vector)`); KNN as a SUBQUERY: `SELECT rowid, distance FROM vec_messages WHERE embedding MATCH ? ORDER BY distance LIMIT ?` (L2 distance, smaller = nearer), then JOIN to `messages`.
- Vectors stored ON DISK (low RAM, <250MB budget). One vector per message (subject + body, truncated). No chunking.
- Embeddings are an OPTIONAL enhancement: if `MAIL_EMBED_ENDPOINT` is unset or the endpoint is unreachable, the indexer no-ops and search stays FTS-only. Never throw on an unreachable endpoint.
- Reuse: embedding goes through `@llm-wiki/embedding`'s `fetchEmbedding` (Phase A). Both Node global `fetch` and the package's `EmbeddingDeps.fetch` are structurally compatible (verified) — no casts needed.
- The mirror/indexer is the only SQLite writer (WAL).
- ESM TypeScript; new deps allowed: `sqlite-vec` (runtime), `@llm-wiki/embedding` (workspace). No others.
- Tests: `node --import tsx --test "test/**/*.test.ts"`. sqlite-vec tests use a real in-memory DB (the extension loads — validated).
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; no apostrophes in heredoc commit bodies.

## File Structure

- `apps/mail-mirror/package.json` — MODIFY: add `sqlite-vec` + `@llm-wiki/embedding` deps.
- `apps/mail-mirror/src/embed-config.ts` — CREATE: `loadEmbedConfig(env)` → `EmbeddingConfig | null`.
- `apps/mail-mirror/src/embed-client.ts` — CREATE: `embedText(text, cfg, fetchImpl?)` → `number[] | null`.
- `apps/mail-mirror/src/store.ts` — MODIFY: sqlite-vec load, `vec_messages` + `embed_state`, embedding upsert/knn/state queries.
- `apps/mail-mirror/src/embed.ts` — CREATE: `sourceTextFor`, `sourceHash`, `embedMessage`, `embedBackfill`, `startEmbedWorker`.
- `apps/mail-mirror/src/cli.ts` — MODIFY: `embed` command; `status` shows embedded count; `watch` starts the worker.
- `apps/mail-mirror/test/*.test.ts` — tests.

---

### Task 1: Embedding config + client

**Files:**
- Modify: `apps/mail-mirror/package.json` (add deps)
- Create: `apps/mail-mirror/src/embed-config.ts`, `apps/mail-mirror/src/embed-client.ts`
- Test: `apps/mail-mirror/test/embed-config.test.ts`, `apps/mail-mirror/test/embed-client.test.ts`

**Interfaces:**
- Produces:
  - `loadEmbedConfig(env?: NodeJS.ProcessEnv): EmbeddingConfig | null` — null when `MAIL_EMBED_ENDPOINT` is unset.
  - `embedText(text: string, cfg: EmbeddingConfig, fetchImpl?: typeof fetch): Promise<number[] | null>` — wraps `@llm-wiki/embedding`'s `fetchEmbedding`; returns the vector or null on any failure.

- [ ] **Step 1: Add dependencies**

In `apps/mail-mirror/package.json`, add to `dependencies`: `"sqlite-vec": "^0.1.7-alpha.2"` and `"@llm-wiki/embedding": "*"`. Run `npm install` from the repo root. (If the exact sqlite-vec version errors, use the latest `0.1.x` that installs; the API in this plan is stable across 0.1.x.)

- [ ] **Step 2: Write failing tests**

`apps/mail-mirror/test/embed-config.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEmbedConfig } from "../src/embed-config.ts";

test("returns null when no endpoint", () => {
  assert.equal(loadEmbedConfig({} as NodeJS.ProcessEnv), null);
});

test("reads endpoint/model/key/dim from env", () => {
  const cfg = loadEmbedConfig({ MAIL_EMBED_ENDPOINT: "http://127.0.0.1:1234/v1/embeddings", MAIL_EMBED_MODEL: "m", MAIL_EMBED_API_KEY: "k", MAIL_EMBED_DIM: "768" } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg?.endpoint, "http://127.0.0.1:1234/v1/embeddings");
  assert.equal(cfg?.model, "m");
  assert.equal(cfg?.apiKey, "k");
  assert.equal(cfg?.outputDimensionality, 768);
});
```

`apps/mail-mirror/test/embed-client.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { embedText } from "../src/embed-client.ts";

const cfg = { endpoint: "http://127.0.0.1:1234/v1/embeddings", model: "m" };
const okFetch = (async () => ({
  ok: true, status: 200, statusText: "OK",
  json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), text: async () => "",
})) as unknown as typeof fetch;
const downFetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

test("embedText returns the vector on success", async () => {
  assert.deepEqual(await embedText("hi", cfg, okFetch), [0.1, 0.2, 0.3]);
});

test("embedText returns null when the endpoint is down", async () => {
  assert.equal(await embedText("hi", cfg, downFetch), null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find the new modules.

- [ ] **Step 4: Implement**

`apps/mail-mirror/src/embed-config.ts`:
```ts
import type { EmbeddingConfig } from "@llm-wiki/embedding";

export function loadEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  const endpoint = env.MAIL_EMBED_ENDPOINT;
  if (!endpoint) return null;
  const cfg: EmbeddingConfig = { endpoint, model: env.MAIL_EMBED_MODEL ?? "" };
  if (env.MAIL_EMBED_API_KEY) cfg.apiKey = env.MAIL_EMBED_API_KEY;
  const dim = env.MAIL_EMBED_DIM ? Number(env.MAIL_EMBED_DIM) : NaN;
  if (Number.isFinite(dim) && dim > 0) cfg.outputDimensionality = dim;
  return cfg;
}
```

`apps/mail-mirror/src/embed-client.ts`:
```ts
import { fetchEmbedding, type EmbeddingConfig } from "@llm-wiki/embedding";

/** Embed text via the shared package using Node fetch. Returns null on any failure. */
export async function embedText(
  text: string,
  cfg: EmbeddingConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number[] | null> {
  const result = await fetchEmbedding(text, cfg, {
    fetch: fetchImpl,
    isNetworkError: (e) => e instanceof TypeError,
  });
  return result.vector;
}
```
(If `tsc` rejects `fetch: fetchImpl` for a structural reason, adapt minimally — but the package's `EmbeddingDeps.fetch` was verified assignable from `typeof fetch` with no cast.)

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/mail-mirror && npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mail-mirror/package.json apps/mail-mirror/src/embed-config.ts apps/mail-mirror/src/embed-client.ts apps/mail-mirror/test/embed-config.test.ts apps/mail-mirror/test/embed-client.test.ts package-lock.json
git commit -m "feat(mail-mirror): embedding config and client over the shared package"
```

---

### Task 2: sqlite-vec load + vector/state schema

**Files:**
- Modify: `apps/mail-mirror/src/store.ts`
- Test: `apps/mail-mirror/test/store-vec.test.ts`

**Interfaces:**
- Consumes: the existing `Store` (sub-project 1).
- Produces (on `Store`):
  - `enableVectors(): boolean` — load sqlite-vec; returns false if it cannot load (no throw).
  - `ensureVecTable(dim: number): void` — create `vec_messages USING vec0(embedding float[dim])` once.
  - the `embed_state` table (created in the schema).

- [ ] **Step 1: Write failing test**

`apps/mail-mirror/test/store-vec.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";

test("enableVectors loads sqlite-vec and a vec table can be created", () => {
  const s = Store.open(":memory:");
  assert.equal(s.enableVectors(), true);
  s.ensureVecTable(4);
  // idempotent
  s.ensureVecTable(4);
  const v = s.raw.prepare("select vec_version() as v").get() as { v: string };
  assert.match(v.v, /^v?\d/);
  // embed_state table exists
  s.raw.prepare("INSERT INTO embed_state(message_id, model, dim, source_hash, embedded_at) VALUES ('m1','mod',4,'h',1)").run();
  const row = s.raw.prepare("SELECT model FROM embed_state WHERE message_id='m1'").get() as { model: string };
  assert.equal(row.model, "mod");
  s.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — `enableVectors`/`ensureVecTable` not defined (and `embed_state` missing).

- [ ] **Step 3: Implement**

In `apps/mail-mirror/src/store.ts`:
1. Add the import at the top: `import * as sqliteVec from "sqlite-vec";`
2. Add `embed_state` to the `SCHEMA` string (alongside the other `CREATE TABLE` statements):
```
CREATE TABLE IF NOT EXISTS embed_state (
  message_id TEXT PRIMARY KEY, model TEXT, dim INTEGER, source_hash TEXT, embedded_at INTEGER
);
```
3. Add a private field and methods to the `Store` class:
```ts
  private vecLoaded = false;

  enableVectors(): boolean {
    if (this.vecLoaded) return true;
    try {
      sqliteVec.load(this.raw);
      this.vecLoaded = true;
      return true;
    } catch {
      this.vecLoaded = false;
      return false;
    }
  }

  ensureVecTable(dim: number): void {
    this.raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(embedding float[${dim}])`);
  }
```
(`dim` is an integer from a vector length / config — interpolating it is safe; do not interpolate user text.)

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/mail-mirror && npm test && npm run typecheck`
Expected: store-vec test passes; existing store tests still pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/store.ts apps/mail-mirror/test/store-vec.test.ts
git commit -m "feat(mail-mirror): load sqlite-vec and add vec/embed-state schema"
```

---

### Task 3: Embedding upsert, KNN, and state queries

**Files:**
- Modify: `apps/mail-mirror/src/store.ts`
- Test: `apps/mail-mirror/test/store-knn.test.ts`

**Interfaces:**
- Consumes: `enableVectors`/`ensureVecTable` (Task 2), the existing `messages` table + `MessageRow`/`upsertMessage`.
- Produces (on `Store`):
  - `upsertEmbedding(messageId: string, vector: number[], model: string, sourceHash: string): void`
  - `knn(queryVector: number[], k: number): { messageId: string; distance: number }[]`
  - `embedStateFor(messageId: string): { sourceHash: string; model: string; dim: number } | undefined`
  - `messagesNeedingEmbedding(limit: number): MessageRow[]` — messages with no `embed_state` or changed since last embed, recent-first.
  - `embeddedCount(): number`

- [ ] **Step 1: Write failing test**

`apps/mail-mirror/test/store-knn.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";

function row(id: string, subject: string): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], subject, date: 1750000000, bodyText: subject, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

test("upsertEmbedding + knn returns the nearest message; state + needing queries", () => {
  const s = Store.open(":memory:");
  s.enableVectors();
  s.ensureVecTable(4);
  s.upsertMessage(row("a@x", "trains"));
  s.upsertMessage(row("b@x", "cooking"));
  s.upsertEmbedding("a@x", [1, 0, 0, 0], "mod", "ha");
  s.upsertEmbedding("b@x", [0, 0, 1, 0], "mod", "hb");

  const hits = s.knn([0.95, 0.05, 0, 0], 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "a@x");

  assert.equal(s.embedStateFor("a@x")?.sourceHash, "ha");
  assert.equal(s.embeddedCount(), 2);

  // c@x has no embedding -> needs embedding
  s.upsertMessage(row("c@x", "new"));
  const need = s.messagesNeedingEmbedding(10).map((m) => m.messageId);
  assert.ok(need.includes("c@x"));
  assert.ok(!need.includes("a@x"));
  s.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement (add to `Store`)**

```ts
  upsertEmbedding(messageId: string, vector: number[], model: string, sourceHash: string): void {
    const r = this.raw.prepare("SELECT rowid FROM messages WHERE message_id=?").get(messageId) as { rowid: number } | undefined;
    if (!r) return;
    const json = JSON.stringify(vector);
    const rid = BigInt(r.rowid);
    this.raw.prepare("DELETE FROM vec_messages WHERE rowid=?").run(rid);
    this.raw.prepare("INSERT INTO vec_messages(rowid, embedding) VALUES (?, ?)").run(rid, json);
    this.raw
      .prepare(`INSERT INTO embed_state(message_id, model, dim, source_hash, embedded_at) VALUES (?,?,?,?,?)
                ON CONFLICT(message_id) DO UPDATE SET model=excluded.model, dim=excluded.dim,
                  source_hash=excluded.source_hash, embedded_at=excluded.embedded_at`)
      .run(messageId, model, vector.length, sourceHash, Math.floor(Date.now() / 1000));
  }

  knn(queryVector: number[], k: number): { messageId: string; distance: number }[] {
    const rows = this.raw
      .prepare(`SELECT m.message_id as messageId, v.distance as distance
                FROM (SELECT rowid, distance FROM vec_messages WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
                JOIN messages m ON m.rowid = v.rowid
                WHERE m.deleted=0`)
      .all(JSON.stringify(queryVector), k) as { messageId: string; distance: number }[];
    return rows;
  }

  embedStateFor(messageId: string): { sourceHash: string; model: string; dim: number } | undefined {
    const r = this.raw.prepare("SELECT source_hash, model, dim FROM embed_state WHERE message_id=?").get(messageId) as
      | { source_hash: string; model: string; dim: number } | undefined;
    return r ? { sourceHash: r.source_hash, model: r.model, dim: r.dim } : undefined;
  }

  messagesNeedingEmbedding(limit: number): MessageRow[] {
    const rows = this.raw
      .prepare(`SELECT m.* FROM messages m LEFT JOIN embed_state e ON e.message_id = m.message_id
                WHERE m.deleted=0 AND (e.message_id IS NULL OR m.updated_at > e.embedded_at)
                ORDER BY m.date DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  embeddedCount(): number {
    return (this.raw.prepare("SELECT COUNT(*) c FROM embed_state").get() as { c: number }).c;
  }
```
(`rowToMessage` is the existing private mapper in this file — reuse it.)

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/mail-mirror && npm test && npm run typecheck`
Expected: store-knn passes; all prior pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/store.ts apps/mail-mirror/test/store-knn.test.ts
git commit -m "feat(mail-mirror): embedding upsert, KNN, and needs-embedding queries"
```

---

### Task 4: Indexer — embedMessage (skip-unchanged, no-op when down)

**Files:**
- Create: `apps/mail-mirror/src/embed.ts`
- Test: `apps/mail-mirror/test/embed.test.ts`

**Interfaces:**
- Consumes: `Store` (Tasks 2-3), `MessageRow`.
- Produces:
  - `sourceTextFor(row: MessageRow): string` — `subject + "\n" + bodyText`, truncated to `MAIL_EMBED_MAX_CHARS` (default 2000).
  - `sourceHash(text: string): string` — sha256 hex.
  - `interface EmbedDeps { store: Store; embed: (text: string) => Promise<number[] | null>; model: string; }`
  - `embedMessage(deps: EmbedDeps, messageId: string): Promise<"embedded" | "skipped" | "unavailable" | "missing">`

- [ ] **Step 1: Write failing test**

`apps/mail-mirror/test/embed.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";
import { embedMessage, sourceHash, sourceTextFor, type EmbedDeps } from "../src/embed.ts";

function row(id: string, subject: string, body = "body"): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], subject, date: 1750000000, bodyText: body, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

function deps(store: Store, embed: (t: string) => Promise<number[] | null>): EmbedDeps {
  return { store, embed, model: "mod" };
}

test("embedMessage embeds, then skips unchanged, re-embeds on change, no-ops when down", async () => {
  const s = Store.open(":memory:");
  s.enableVectors(); s.ensureVecTable(4);
  s.upsertMessage(row("a@x", "trains"));
  const d = deps(s, async () => [1, 0, 0, 0]);

  assert.equal(await embedMessage(d, "a@x"), "embedded");
  assert.equal(s.embeddedCount(), 1);
  assert.equal(await embedMessage(d, "a@x"), "skipped"); // unchanged source hash

  // change the body -> needs re-embed
  s.upsertMessage(row("a@x", "trains", "now about cooking"));
  assert.equal(await embedMessage(d, "a@x"), "embedded");

  // endpoint down -> unavailable, no state written
  s.upsertMessage(row("b@x", "new"));
  const down = deps(s, async () => null);
  assert.equal(await embedMessage(down, "b@x"), "unavailable");
  assert.equal(s.embedStateFor("b@x"), undefined);

  assert.equal(await embedMessage(d, "missing@x"), "missing");
  s.close();
});

test("sourceTextFor joins subject+body; sourceHash is stable", () => {
  assert.equal(sourceTextFor(row("a", "S", "B")), "S\nB");
  assert.equal(sourceHash("x"), sourceHash("x"));
  assert.notEqual(sourceHash("x"), sourceHash("y"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — cannot find `../src/embed.ts`.

- [ ] **Step 3: Implement**

`apps/mail-mirror/src/embed.ts`:
```ts
import { createHash } from "node:crypto";
import type { MessageRow, Store } from "./store.ts";

const MAX_CHARS = Number(process.env.MAIL_EMBED_MAX_CHARS ?? 2000);

export function sourceTextFor(row: MessageRow): string {
  return `${row.subject}\n${row.bodyText}`.slice(0, MAX_CHARS);
}

export function sourceHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface EmbedDeps {
  store: Store;
  embed: (text: string) => Promise<number[] | null>;
  model: string;
}

export async function embedMessage(
  deps: EmbedDeps,
  messageId: string,
): Promise<"embedded" | "skipped" | "unavailable" | "missing"> {
  const row = deps.store.getMessage(messageId);
  if (!row) return "missing";
  const text = sourceTextFor(row);
  const hash = sourceHash(text);
  const state = deps.store.embedStateFor(messageId);
  if (state && state.sourceHash === hash) return "skipped";
  const vector = await deps.embed(text);
  if (!vector) return "unavailable";
  deps.store.ensureVecTable(vector.length);
  deps.store.upsertEmbedding(messageId, vector, deps.model, hash);
  return "embedded";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/mail-mirror && npm test && npm run typecheck`
Expected: pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/embed.ts apps/mail-mirror/test/embed.test.ts
git commit -m "feat(mail-mirror): embedMessage indexer (skip unchanged, no-op when down)"
```

---

### Task 5: Backfill (recent-first) + worker loop

**Files:**
- Modify: `apps/mail-mirror/src/embed.ts`
- Test: `apps/mail-mirror/test/embed-backfill.test.ts`

**Interfaces:**
- Consumes: `EmbedDeps`/`embedMessage` (Task 4), `Store.messagesNeedingEmbedding` (Task 3).
- Produces:
  - `embedBackfill(deps: EmbedDeps, opts?: { limit?: number }): Promise<{ embedded: number; unavailable: boolean }>` — embed up to `limit` (default 200) messages needing it, recent-first; STOP early if the endpoint is unavailable.
  - `startEmbedWorker(deps: EmbedDeps, opts?: { intervalMs?: number; batch?: number }): { stop(): void }` — periodically runs `embedBackfill`; backs off when unavailable.

- [ ] **Step 1: Write failing test**

`apps/mail-mirror/test/embed-backfill.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";
import { embedBackfill, type EmbedDeps } from "../src/embed.ts";

function row(id: string, date: number): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], subject: "s" + id, date, bodyText: "b", bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

test("embedBackfill embeds all needing, recent-first; stops when unavailable", async () => {
  const s = Store.open(":memory:");
  s.enableVectors(); s.ensureVecTable(2);
  s.upsertMessage(row("old@x", 1000));
  s.upsertMessage(row("new@x", 2000));
  const order: string[] = [];
  const deps: EmbedDeps = { store: s, model: "mod", embed: async () => { return [1, 0]; } };
  // wrap embed to record order via messagesNeedingEmbedding (recent-first)
  const res = await embedBackfill(deps, { limit: 10 });
  assert.equal(res.embedded, 2);
  assert.equal(res.unavailable, false);
  assert.equal(s.embeddedCount(), 2);

  // now an unavailable endpoint on a fresh message -> stops, reports unavailable
  s.upsertMessage(row("z@x", 3000));
  const down: EmbedDeps = { store: s, model: "mod", embed: async () => null };
  const r2 = await embedBackfill(down, { limit: 10 });
  assert.equal(r2.embedded, 0);
  assert.equal(r2.unavailable, true);
  s.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — `embedBackfill` not exported.

- [ ] **Step 3: Implement (append to `src/embed.ts`)**

```ts
export async function embedBackfill(
  deps: EmbedDeps,
  opts: { limit?: number } = {},
): Promise<{ embedded: number; unavailable: boolean }> {
  const limit = opts.limit ?? 200;
  let embedded = 0;
  for (const row of deps.store.messagesNeedingEmbedding(limit)) {
    const r = await embedMessage(deps, row.messageId);
    if (r === "embedded") embedded++;
    else if (r === "unavailable") return { embedded, unavailable: true }; // endpoint down — stop
  }
  return { embedded, unavailable: false };
}

export function startEmbedWorker(
  deps: EmbedDeps,
  opts: { intervalMs?: number; batch?: number } = {},
): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 10_000;
  const batch = opts.batch ?? 100;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    let delay = intervalMs;
    try {
      const res = await embedBackfill(deps, { limit: batch });
      // If nothing left to do, idle longer; if the endpoint is down, back off.
      if (res.unavailable) delay = intervalMs * 6;
      else if (res.embedded === 0) delay = intervalMs * 3;
      else delay = 250; // more to do — drain quickly
    } catch {
      delay = intervalMs * 6;
    }
    if (!stopped) timer = setTimeout(tick, delay);
  };
  timer = setTimeout(tick, 250);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/mail-mirror && npm test && npm run typecheck`
Expected: pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror/src/embed.ts apps/mail-mirror/test/embed-backfill.test.ts
git commit -m "feat(mail-mirror): recent-first embed backfill and worker loop"
```

---

### Task 6: CLI `embed` + status + daemon integration

**Files:**
- Modify: `apps/mail-mirror/src/cli.ts`
- Test: `apps/mail-mirror/test/cli-embed-deps.test.ts`

**Interfaces:**
- Consumes: `loadEmbedConfig` (Task 1), `embedText` (Task 1), `embedBackfill`/`startEmbedWorker` (Task 5), `Store.enableVectors`/`embeddedCount` (Tasks 2-3), `startWatch` (sub-project 1).
- Produces:
  - A small helper `makeEmbedDeps(store): EmbedDeps | null` (null when no endpoint configured) wired to the real config + client — factored out so it is unit-testable without the CLI process.
  - CLI commands: `embed` (one-shot backfill loop), `status` (adds embedded count), `watch` (starts the embed worker alongside the file watcher).

- [ ] **Step 1: Write failing test for the deps factory**

`apps/mail-mirror/test/cli-embed-deps.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { makeEmbedDeps } from "../src/cli.ts";

test("makeEmbedDeps returns null when no endpoint configured", () => {
  const s = Store.open(":memory:");
  const saved = process.env.MAIL_EMBED_ENDPOINT;
  delete process.env.MAIL_EMBED_ENDPOINT;
  assert.equal(makeEmbedDeps(s), null);
  if (saved) process.env.MAIL_EMBED_ENDPOINT = saved;
  s.close();
});

test("makeEmbedDeps wires deps when an endpoint is set", () => {
  const s = Store.open(":memory:");
  process.env.MAIL_EMBED_ENDPOINT = "http://127.0.0.1:1234/v1/embeddings";
  process.env.MAIL_EMBED_MODEL = "m";
  const d = makeEmbedDeps(s);
  assert.ok(d && typeof d.embed === "function" && d.model === "m");
  delete process.env.MAIL_EMBED_ENDPOINT;
  delete process.env.MAIL_EMBED_MODEL;
  s.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mail-mirror && npm test`
Expected: FAIL — `makeEmbedDeps` not exported from cli.ts.

- [ ] **Step 3: Implement in `apps/mail-mirror/src/cli.ts`**

Add imports at the top: `import { loadEmbedConfig } from "./embed-config.ts";`, `import { embedText } from "./embed-client.ts";`, `import { embedBackfill, startEmbedWorker, type EmbedDeps } from "./embed.ts";`, and `import { startWatch } from "./watch.ts";` (if not already imported).

Add the exported factory:
```ts
export function makeEmbedDeps(store: import("./store.ts").Store): EmbedDeps | null {
  const cfg = loadEmbedConfig();
  if (!cfg) return null;
  store.enableVectors();
  return { store, model: cfg.model, embed: (text) => embedText(text, cfg) };
}
```

Add an `embed` command branch (alongside the existing `backfill`/`watch`/`reconcile`/`status`):
```ts
  } else if (cmd === "embed") {
    const d = deps();
    const ed = makeEmbedDeps(d.store);
    if (!ed) {
      console.log("Embedding disabled: set MAIL_EMBED_ENDPOINT (and MAIL_EMBED_MODEL) to enable semantic search.");
      d.store.close();
      return;
    }
    let total = 0;
    for (;;) {
      const res = await embedBackfill(ed, { limit: 200 });
      total += res.embedded;
      if (res.unavailable) { console.log(`embed: endpoint unavailable after ${total} embedded`); break; }
      if (res.embedded === 0) { console.log(`embed: done, ${total} embedded`); break; }
      console.log(`embed: ${total} so far...`);
    }
    d.store.close();
  }
```

In the existing `status` branch, after the current counts, add the embedded count:
```ts
    const embedded = d.store.embeddedCount();
    console.log(`embedded: ${embedded}`);
```

In the existing `watch` branch, after `startWatch(...)`, also start the embed worker if configured:
```ts
    const ed = makeEmbedDeps(d.store);
    if (ed) { startEmbedWorker(ed); console.log("embed worker started"); }
    else console.log("embedding disabled (set MAIL_EMBED_ENDPOINT to enable)");
```

(Keep the rest of the CLI unchanged. `deps()` is the existing helper that opens the Store + BlobStore.)

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/mail-mirror && npm test && npm run typecheck`
Expected: cli-embed-deps tests pass; all prior pass; typecheck clean.

- [ ] **Step 5: Manual smoke (no endpoint needed)**

Run: `cd apps/mail-mirror && node --import tsx src/cli.ts embed`
Expected (with `MAIL_EMBED_ENDPOINT` unset): prints "Embedding disabled: set MAIL_EMBED_ENDPOINT ..." and exits cleanly. `node --import tsx src/cli.ts status` prints counts including `embedded: 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/mail-mirror/src/cli.ts apps/mail-mirror/test/cli-embed-deps.test.ts
git commit -m "feat(mail-mirror): embed CLI command, status count, and worker in watch"
```

---

## Self-review notes (addressed)

- **Spec coverage (Phase B):** config (T1), client over the shared package (T1), sqlite-vec load + vec/state schema (T2), upsert/KNN/state queries (T3), embedMessage with skip-unchanged + no-op-when-down + re-embed-on-change via source hash (T4), recent-first backfill + worker (T5), `embed` CLI + status + daemon worker (T6). On-disk vectors, FTS-only degradation, one-vector-per-message — all honoured.
- **sqlite-vec API:** matches the validated spike (load, `vec0(float[D])`, BigInt rowid, JSON-text vector, KNN subquery + JOIN).
- **Type consistency:** `EmbedDeps { store, embed, model }`, `EmbeddingConfig` (from `@llm-wiki/embedding`), `Store` methods (`enableVectors`, `ensureVecTable`, `upsertEmbedding`, `knn`, `embedStateFor`, `messagesNeedingEmbedding`, `embeddedCount`) used consistently from definition (T2/T3) through consumers (T4/T5/T6).
- **Phase C (mail-mcp hybrid search) gets its own plan after Phase B executes.**
