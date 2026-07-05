# Calendar MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/calendar-mcp`, an MCP server that reads/searches/writes the macOS Calendar, reusing shared code extracted from the mail apps.

**Architecture:** Reads come from Apple's `Calendar.sqlitedb` (read-only, Full Disk Access); writes go through AppleScript (`osascript`, Automation permission); hybrid keyword+semantic search runs over a connector-owned sidecar index DB (FTS5 + sqlite-vec) populated by a sync step that embeds via the LLM gateway. Genuinely-shared pieces (AppleScript runner/escaper, RRF, sqlite-vec vector store, embed wrappers) are first extracted into `packages/applescript` and `packages/search` so the mail apps and calendar-mcp share them instead of duplicating.

**Tech Stack:** TypeScript (ESM, `tsx`), `@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `@steward/embedding`, `node:test`, macOS `osascript`.

## Global Constraints

- Apple's `Calendar.sqlitedb` is opened **read-only and never written**.
- `packages/embedding` stays pure (no `better-sqlite3` / `sqlite-vec`); the wiki 90/90 gate must stay green — put nothing sqlite-related there.
- Commit only on the current feature branch; never `main`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (no apostrophes in heredoc bodies).
- Do not delete `apps/mail-mcp/realtest.mts` or `apps/mail-mirror/e2e-smoke.mts`.
- Embeddings route through the LLM gateway by default (model `local-embed`, endpoint `http://127.0.0.1:4000/v1/embeddings`); `MAIL_EMBED_ENDPOINT=off` disables.
- No new TCC permission: reads use existing FDA, writes use existing Automation grant.
- After every extraction/refactor task, the mail-mcp and mail-mirror suites must stay green.
- Events are `CalendarItem` rows with `entity_type = 2`. Core Data dates are seconds since 2001-01-01 UTC; Unix seconds = value + `978307200`.
- All new packages/apps use `"type": "module"` and the test script `node --import tsx --test "test/**/*.test.ts"`.

---

## File Structure

**New shared packages**
- `packages/applescript/src/index.ts` — `esc`, `runOsa`, `OsaExec`, `OsaOptions` (injectable `mapError`).
- `packages/search/src/index.ts` — re-exports `rrf`, `embedText`/`embedTexts`, `VectorStore`.
- `packages/search/src/rrf.ts`, `packages/search/src/embed-client.ts`, `packages/search/src/vector-store.ts`.

**Refactored**
- `apps/mail-mcp/src/osascript.ts` → keeps `mapOsaError`, re-exports `runOsa` from package.
- `apps/mail-mcp/src/applescript.ts` → imports `esc` from package.
- `apps/mail-mcp/src/rrf.ts` → re-exports from package.
- `apps/mail-mirror/src/embed-client.ts` → re-exports from package.
- `apps/mail-mirror/src/store.ts` → uses `VectorStore`.

**New app `apps/calendar-mcp/src`**
- `paths.ts` — sidecar DB path, Apple store path.
- `coredata.ts` — Core Data date conversions (pure).
- `apple-store.ts` — read-only Apple store reader.
- `index-db.ts` — sidecar schema + upsert/delete/state.
- `sync.ts` — incremental index + embedding.
- `search.ts` — hybrid FTS+vector+RRF.
- `applescript.ts` — pure create/update/delete builders + Calendar error mapper.
- `args.ts` / `types.ts` — arg validation + types.
- `cli.ts` — `index`/`sync`/`status`.
- `index.ts` — MCP server.
- `realtest.mts` — live, excluded from CI.

---

### Task 1: `packages/applescript` — runner + escaper

**Files:**
- Create: `packages/applescript/package.json`
- Create: `packages/applescript/tsconfig.json`
- Create: `packages/applescript/src/index.ts`
- Test: `packages/applescript/test/applescript.test.ts`

**Interfaces:**
- Produces: `esc(s: string): string`; `type OsaExec = (script: string, timeoutMs: number) => Promise<string>`; `interface OsaOptions { timeoutMs?: number; exec?: OsaExec; mapError?: (stderr: string) => string; isTransient?: (message: string) => boolean }`; `runOsa(script: string, opts?: OsaOptions): Promise<string>`.

- [ ] **Step 1: Create the package manifest**

`packages/applescript/package.json`:
```json
{
  "name": "@steward/applescript",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

`packages/applescript/tsconfig.json`:
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

- [ ] **Step 2: Write the failing test**

`packages/applescript/test/applescript.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { esc, runOsa } from "../src/index.ts";

test("esc escapes backslashes and quotes", () => {
  assert.equal(esc('a"b\\c'), 'a\\"b\\\\c');
});

test("runOsa returns stdout from the injected exec", async () => {
  const out = await runOsa("script", { exec: async () => "hello\n" });
  assert.equal(out, "hello\n");
});

test("runOsa retries once on a transient error then succeeds", async () => {
  let calls = 0;
  const out = await runOsa("s", {
    exec: async () => {
      calls++;
      if (calls === 1) throw new Error("connection is invalid (-609)");
      return "ok";
    },
  });
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("runOsa maps a non-transient error via mapError and does not retry", async () => {
  let calls = 0;
  await assert.rejects(
    runOsa("s", {
      exec: async () => { calls++; throw new Error("-1743 Not authorized"); },
      mapError: () => "AUTOMATION_BLOCKED",
    }),
    /AUTOMATION_BLOCKED/,
  );
  assert.equal(calls, 1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/applescript && node --import tsx --test test/applescript.test.ts`
Expected: FAIL — cannot find `../src/index.ts`.

- [ ] **Step 4: Implement `src/index.ts`**

`packages/applescript/src/index.ts`:
```ts
import { execFile } from "node:child_process";

/** Escape a string for inclusion inside an AppleScript double-quoted literal. */
export function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export type OsaExec = (script: string, timeoutMs: number) => Promise<string>;

export interface OsaOptions {
  timeoutMs?: number;
  exec?: OsaExec;
  /** Translate raw stderr into a user-facing message. Default: trimmed stderr. */
  mapError?: (stderr: string) => string;
  /** Decide whether a failure message is worth one automatic retry. */
  isTransient?: (message: string) => boolean;
}

function defaultIsTransient(message: string): boolean {
  return /-609\b|connection is invalid|temporarily invalid/i.test(message);
}

const defaultExec: OsaExec = (script, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) { resolve(stdout); return; }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (e.killed || e.signal === "SIGTERM") {
          reject(new Error("osascript timed out"));
        } else {
          reject(new Error((stderr || "osascript failed").trim()));
        }
      },
    );
  });

export async function runOsa(script: string, opts: OsaOptions = {}): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const isTransient = opts.isTransient ?? defaultIsTransient;
  try {
    return await exec(script, timeoutMs);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (!isTransient(raw)) {
      throw new Error(opts.mapError ? opts.mapError(raw) : raw);
    }
    await new Promise((r) => setTimeout(r, 300));
    try {
      return await exec(script, timeoutMs);
    } catch (err2) {
      const raw2 = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(opts.mapError ? opts.mapError(raw2) : raw2);
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/applescript && node --import tsx --test test/applescript.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Add the package to the workspace and typecheck**

Confirm the root `package.json` `workspaces` array already globs `packages/*` (it does for `embedding`/`protocol`). If it lists packages explicitly, add `"packages/applescript"`. Run:
`npm install` then `cd packages/applescript && npx tsc --noEmit`
Expected: tsc clean.

- [ ] **Step 7: Commit**

```bash
git add packages/applescript package.json package-lock.json
git commit -m "feat(applescript): shared osascript runner + esc with injectable error mapper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Refactor mail-mcp onto `@steward/applescript`

**Files:**
- Modify: `apps/mail-mcp/src/osascript.ts`
- Modify: `apps/mail-mcp/src/applescript.ts:13` (the `esc` definition)
- Modify: `apps/mail-mcp/package.json` (add dependency)

**Interfaces:**
- Consumes: `esc`, `runOsa`, `OsaExec` from `@steward/applescript`.
- Produces: unchanged public surface of `osascript.ts` (`runOsa`, `mapOsaError`, `OsaExec`) and `applescript.ts` (`esc`).

- [ ] **Step 1: Add the dependency**

In `apps/mail-mcp/package.json` `dependencies`, add: `"@steward/applescript": "*"`. Run `npm install`.

- [ ] **Step 2: Rewrite `osascript.ts` to delegate, keeping Mail mapping**

Replace the whole `apps/mail-mcp/src/osascript.ts` with:
```ts
import { runOsa as sharedRunOsa, type OsaExec, type OsaOptions } from "@steward/applescript";

export type { OsaExec };

export function mapOsaError(stderr: string): string {
  if (/-600\b|isn.t running/i.test(stderr)) {
    return "Mail.app is not running. Open Mail and try again.";
  }
  if (/-1743\b|Not authorized/i.test(stderr)) {
    return "Automation permission for Mail is not granted. Allow it in System Settings → Privacy & Security → Automation.";
  }
  if (/-609\b|connection is invalid/i.test(stderr)) {
    return "Mail connection was temporarily invalid (-609). Retried.";
  }
  if (/timed out/i.test(stderr)) {
    return "Mail timed out — the message body may still be downloading from the server (Exchange/IMAP). Try again in a moment.";
  }
  return stderr.trim() || "osascript failed";
}

export async function runOsa(
  script: string,
  opts: { timeoutMs?: number; exec?: OsaExec } = {},
): Promise<string> {
  const full: OsaOptions = { ...opts, mapError: mapOsaError };
  return sharedRunOsa(script, full);
}
```

- [ ] **Step 3: Replace `esc` in `applescript.ts` with the shared import**

In `apps/mail-mcp/src/applescript.ts`, delete the local `export function esc(...)` block (around line 13) and add to the top imports:
```ts
import { esc } from "@steward/applescript";
```
Keep `export { esc };` at the end of the file if other modules import `esc` from `./applescript.ts` — verify with `grep -rn "esc" apps/mail-mcp/src` and preserve the existing import surface by re-exporting.

- [ ] **Step 4: Run the mail-mcp suite**

Run: `cd apps/mail-mcp && npm test && npx tsc --noEmit`
Expected: all existing tests pass; tsc clean. The retry-message wording for timeouts now comes through `mapOsaError`; if a test asserts the exact old timeout string, confirm it still matches (it does — the message text is preserved above).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mcp package.json package-lock.json
git commit -m "refactor(mail-mcp): consume shared @steward/applescript (esc, runOsa)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `packages/search` — rrf + embed wrappers + VectorStore

**Files:**
- Create: `packages/search/package.json`, `packages/search/tsconfig.json`
- Create: `packages/search/src/rrf.ts`, `packages/search/src/embed-client.ts`, `packages/search/src/vector-store.ts`, `packages/search/src/index.ts`
- Test: `packages/search/test/rrf.test.ts`, `packages/search/test/vector-store.test.ts`

**Interfaces:**
- Produces:
  - `rrf(rankings: string[][], k?: number): { id: string; score: number }[]`
  - `embedText(text, cfg, fetchImpl?): Promise<number[] | null>`; `embedTexts(texts, cfg, fetchImpl?): Promise<(number[] | null)[]>`
  - `class VectorStore` with: `constructor(raw: Database, opts: { table: string; stateKey?: string; getState; setState })`, `enable(): boolean`, `ensureTable(dim: number): void`, `upsert(rowid: number | bigint, vector: number[]): void`, `knn(vector: number[], k: number): { rowid: number; distance: number }[]`.

- [ ] **Step 1: Create manifests**

`packages/search/package.json`:
```json
{
  "name": "@steward/search",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
  "dependencies": {
    "@steward/embedding": "*",
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
`packages/search/tsconfig.json`: same content as Task 1 Step 1's tsconfig.

- [ ] **Step 2: Write the failing rrf + vector-store tests**

`packages/search/test/rrf.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { rrf } from "../src/rrf.ts";

test("rrf fuses two rankings, higher when ranked well in both", () => {
  const out = rrf([["a", "b", "c"], ["b", "a", "d"]]);
  assert.equal(out[0].id, "a"); // a: 1/61 + 1/62 ; b: 1/62 + 1/61 — tie broken by id desc -> b? check
});

test("rrf tiebreak is id descending", () => {
  const out = rrf([["a", "b"], ["b", "a"]]);
  // equal scores -> "b" before "a"
  assert.equal(out[0].id, "b");
});
```

`packages/search/test/vector-store.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { VectorStore } from "../src/vector-store.ts";

function makeStore() {
  const raw = new Database(":memory:");
  const state = new Map<string, string>();
  const vs = new VectorStore(raw, {
    table: "vec_items",
    getState: (k) => state.get(k),
    setState: (k, v) => void state.set(k, v),
  });
  return { raw, vs };
}

test("VectorStore upserts and KNN returns nearest rowid first", () => {
  const { vs } = makeStore();
  assert.equal(vs.enable(), true);
  vs.ensureTable(3);
  vs.upsert(1, [1, 0, 0]);
  vs.upsert(2, [0, 1, 0]);
  const hits = vs.knn([0.9, 0.1, 0], 2);
  assert.equal(hits[0].rowid, 1);
});

test("ensureTable at a new dim drops old vectors", () => {
  const { vs, raw } = makeStore();
  vs.enable();
  vs.ensureTable(3);
  vs.upsert(1, [1, 0, 0]);
  vs.ensureTable(4); // dim change
  const n = (raw.prepare("SELECT COUNT(*) c FROM vec_items").get() as { c: number }).c;
  assert.equal(n, 0);
});
```

> Note: the first rrf test's comment is exploratory; assert only the deterministic tiebreak test. Replace the first test body with the tiebreak assertion to avoid a flaky/incorrect expectation:
```ts
test("rrf ranks an item appearing in both lists above a single-list item", () => {
  const out = rrf([["a", "x"], ["a", "y"]]);
  assert.equal(out[0].id, "a");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd packages/search && node --import tsx --test test/rrf.test.ts test/vector-store.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement rrf.ts (verbatim move from mail-mcp)**

`packages/search/src/rrf.ts`:
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
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return b.id.localeCompare(a.id);
    });
}
```

- [ ] **Step 5: Implement embed-client.ts (move from mail-mirror)**

`packages/search/src/embed-client.ts`:
```ts
import { fetchEmbedding, fetchEmbeddingBatch, type EmbeddingConfig } from "@steward/embedding";

export async function embedText(
  text: string,
  cfg: EmbeddingConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number[] | null> {
  const result = await fetchEmbedding(text, cfg, { fetch: fetchImpl, isNetworkError: (e) => e instanceof TypeError });
  return result.vector;
}

export async function embedTexts(
  texts: string[],
  cfg: EmbeddingConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<(number[] | null)[]> {
  const r = await fetchEmbeddingBatch(texts, cfg, { fetch: fetchImpl, isNetworkError: (e) => e instanceof TypeError });
  return r.vectors;
}
```

- [ ] **Step 6: Implement vector-store.ts (generalize mail-mirror's logic)**

`packages/search/src/vector-store.ts`:
```ts
import type { Database } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export interface VectorStoreOptions {
  table: string;
  /** State key holding the current dimension; defaults to `<table>_dim`. */
  stateKey?: string;
  getState: (key: string) => string | undefined;
  setState: (key: string, value: string) => void;
  /** Called when a dimension change drops the table, so the caller can clear its embed bookkeeping. */
  onDimReset?: () => void;
}

export class VectorStore {
  private loaded = false;
  private readonly key: string;
  constructor(private readonly raw: Database, private readonly opts: VectorStoreOptions) {
    this.key = opts.stateKey ?? `${opts.table}_dim`;
  }

  enable(): boolean {
    if (this.loaded) return true;
    try { sqliteVec.load(this.raw); this.loaded = true; } catch { this.loaded = false; }
    return this.loaded;
  }

  ensureTable(dim: number): void {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`invalid embedding dimension: ${dim}`);
    const cur = this.opts.getState(this.key);
    if (cur && Number(cur) !== dim) {
      this.raw.exec(`DROP TABLE IF EXISTS ${this.opts.table}`);
      this.opts.onDimReset?.();
    }
    this.raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.opts.table} USING vec0(embedding float[${dim}])`);
    if (cur !== String(dim)) this.opts.setState(this.key, String(dim));
  }

  upsert(rowid: number | bigint, vector: number[]): void {
    const rid = BigInt(rowid);
    const json = JSON.stringify(vector);
    this.raw.prepare(`DELETE FROM ${this.opts.table} WHERE rowid=?`).run(rid);
    this.raw.prepare(`INSERT INTO ${this.opts.table}(rowid, embedding) VALUES (?, ?)`).run(rid, json);
  }

  knn(vector: number[], k: number): { rowid: number; distance: number }[] {
    return this.raw
      .prepare(`SELECT rowid, distance FROM ${this.opts.table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
      .all(JSON.stringify(vector), k) as { rowid: number; distance: number }[];
  }
}
```

> The `table` value is always an internal constant supplied by the caller (never user input); it is interpolated into DDL exactly as mail-mirror already does for `vec_messages`.

- [ ] **Step 7: Implement index.ts barrel**

`packages/search/src/index.ts`:
```ts
export { rrf } from "./rrf.ts";
export { embedText, embedTexts } from "./embed-client.ts";
export { VectorStore, type VectorStoreOptions } from "./vector-store.ts";
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npm install` (root), then `cd packages/search && node --import tsx --test "test/**/*.test.ts" && npx tsc --noEmit`
Expected: PASS (3 tests), tsc clean.

- [ ] **Step 9: Commit**

```bash
git add packages/search package.json package-lock.json
git commit -m "feat(search): shared rrf + embed wrappers + sqlite-vec VectorStore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Refactor mail-mcp + mail-mirror onto `@steward/search`

**Files:**
- Modify: `apps/mail-mcp/src/rrf.ts` (re-export)
- Modify: `apps/mail-mcp/package.json`, `apps/mail-mirror/package.json` (dependency)
- Modify: `apps/mail-mirror/src/embed-client.ts` (re-export)
- Modify: `apps/mail-mirror/src/store.ts` (use `VectorStore`)

**Interfaces:**
- Consumes: `rrf`, `embedText`, `embedTexts`, `VectorStore` from `@steward/search`.
- Produces: unchanged public surface of `mail-mcp/src/rrf.ts`, `mail-mirror/src/embed-client.ts`, and `Store` (`upsertEmbedding`, `knn`, `enableVectors`, `ensureVecTable`).

- [ ] **Step 1: Add dependency to both apps**

Add `"@steward/search": "*"` to `dependencies` in both `apps/mail-mcp/package.json` and `apps/mail-mirror/package.json`. Run `npm install`.

- [ ] **Step 2: Re-export rrf and embed-client**

Replace `apps/mail-mcp/src/rrf.ts` contents with:
```ts
export { rrf } from "@steward/search";
```
Replace `apps/mail-mirror/src/embed-client.ts` contents with:
```ts
export { embedText, embedTexts } from "@steward/search";
```

- [ ] **Step 3: Use VectorStore inside mail-mirror Store**

In `apps/mail-mirror/src/store.ts`:
- Remove `import * as sqliteVec from "sqlite-vec";` and the `private vecLoaded = false;` field.
- Add `import { VectorStore } from "@steward/search";` and a field `private vec: VectorStore;`.
- In the constructor (after `this.raw` is created), add:
```ts
this.vec = new VectorStore(this.raw, {
  table: "vec_messages",
  stateKey: "vec_dim",
  getState: (k) => this.getState(k),
  setState: (k, v) => this.setState(k, v),
  onDimReset: () => this.raw.exec("DELETE FROM embed_state"),
});
```
- Replace the bodies of these methods to delegate:
```ts
enableVectors(): boolean { return this.vec.enable(); }

ensureVecTable(dim: number): void { this.vec.ensureTable(dim); }
```
- In `upsertEmbedding`, replace the two `vec_messages` DELETE/INSERT lines with:
```ts
this.vec.upsert(r.rowid, vector);
```
  (keep the surrounding `embed_state` upsert exactly as-is).
- In `knn`, replace the inner vec subquery by calling the helper and joining in JS-free SQL. Simplest: keep the existing SQL but it already references `vec_messages` directly — leave `knn` as the original SQL (it reads `vec_messages` which the helper created). Only the create/upsert/enable paths move to `VectorStore`; `knn`'s join to `messages` stays in `store.ts`.

- [ ] **Step 4: Run both suites**

Run: `cd apps/mail-mirror && npm test && npx tsc --noEmit` then `cd ../mail-mcp && npm test && npx tsc --noEmit`
Expected: both green; tsc clean. (mail-mirror has 70 tests after the gateway-wiring change.)

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mcp apps/mail-mirror package.json package-lock.json
git commit -m "refactor(mail): consume shared @steward/search (rrf, embed, VectorStore)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Scaffold `apps/calendar-mcp` + paths + Core Data dates

**Files:**
- Create: `apps/calendar-mcp/package.json`, `apps/calendar-mcp/tsconfig.json`
- Create: `apps/calendar-mcp/src/paths.ts`
- Create: `apps/calendar-mcp/src/coredata.ts`
- Test: `apps/calendar-mcp/test/coredata.test.ts`

**Interfaces:**
- Produces: `applePath(): string`, `indexDbPath(): string`; `coreDataToUnix(v: number): number`, `unixToCoreData(u: number): number`, `coreDataToISO(v: number): string`, `isoToUnix(s: string): number`.

- [ ] **Step 1: Manifests**

`apps/calendar-mcp/package.json`:
```json
{
  "name": "@steward/calendar-mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
  "dependencies": {
    "@steward/applescript": "*",
    "@steward/embedding": "*",
    "@steward/search": "*",
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
`apps/calendar-mcp/tsconfig.json`: same as Task 1's tsconfig but `"include": ["src", "test"]`.

- [ ] **Step 2: Write the failing coredata test**

`apps/calendar-mcp/test/coredata.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { coreDataToUnix, unixToCoreData, coreDataToISO, isoToUnix } from "../src/coredata.ts";

test("Core Data <-> Unix offset is 978307200", () => {
  assert.equal(coreDataToUnix(0), 978307200);
  assert.equal(unixToCoreData(978307200), 0);
});

test("coreDataToISO renders a known instant", () => {
  // 2001-01-01T00:00:00Z is Core Data 0
  assert.equal(coreDataToISO(0), "2001-01-01T00:00:00.000Z");
});

test("isoToUnix parses ISO to unix seconds", () => {
  assert.equal(isoToUnix("2001-01-01T00:00:00.000Z"), 978307200);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/calendar-mcp && node --import tsx --test test/coredata.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement coredata.ts and paths.ts**

`apps/calendar-mcp/src/coredata.ts`:
```ts
const OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01 (UTC)

export function coreDataToUnix(v: number): number { return v + OFFSET; }
export function unixToCoreData(u: number): number { return u - OFFSET; }
export function coreDataToISO(v: number): string { return new Date(coreDataToUnix(v) * 1000).toISOString(); }
export function isoToUnix(s: string): number { return Math.floor(new Date(s).getTime() / 1000); }
```

`apps/calendar-mcp/src/paths.ts`:
```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function applePath(): string {
  return join(homedir(), "Library", "Group Containers", "group.com.apple.calendar", "Calendar.sqlitedb");
}

export function indexDbPath(): string {
  return process.env.CALENDAR_INDEX_DB ?? join(homedir(), "Library", "Application Support", "llm-wiki", "calendar-index.sqlitedb");
}
```

- [ ] **Step 5: Run the test + typecheck**

Run: `npm install` (root) then `cd apps/calendar-mcp && node --import tsx --test test/coredata.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar-mcp package.json package-lock.json
git commit -m "feat(calendar-mcp): scaffold + Core Data date helpers + paths

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `apple-store.ts` — read-only Apple Calendar reader

**Files:**
- Create: `apps/calendar-mcp/src/types.ts`
- Create: `apps/calendar-mcp/src/apple-store.ts`
- Test: `apps/calendar-mcp/test/apple-store.test.ts`

**Interfaces:**
- Produces:
  - `interface CalEvent { uid: string; summary: string; description: string | null; location: string | null; start: string; end: string; allDay: boolean; calendar: string; account: string; status: number; url: string | null; lastModified: number }`
  - `interface CalendarInfo { title: string; account: string; type: number }`
  - `class AppleStore` with `static openReadonly(path: string): AppleStore`, `listCalendars(): CalendarInfo[]`, `eventsInRange(opts: { startISO: string; endISO: string; account?: string; calendar?: string }): CalEvent[]`, `getEvent(uid: string): CalEvent | undefined`, `allForIndex(): CalEvent[]`, `close(): void`.

- [ ] **Step 1: Write the failing test (over a seeded fake DB matching Apple's shape)**

`apps/calendar-mcp/test/apple-store.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { AppleStore } from "../src/apple-store.ts";
import { unixToCoreData } from "../src/coredata.ts";

function seed(): string {
  const path = `/tmp/cal-apple-${process.pid}-${Math.random()}.sqlitedb`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE Store(ROWID INTEGER PRIMARY KEY, name TEXT, type INTEGER);
    CREATE TABLE Calendar(ROWID INTEGER PRIMARY KEY, store_id INTEGER, title TEXT, type INTEGER);
    CREATE TABLE Location(ROWID INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE CalendarItem(ROWID INTEGER PRIMARY KEY, summary TEXT, description TEXT,
      location_id INTEGER, start_date REAL, end_date REAL, all_day INTEGER, calendar_id INTEGER,
      status INTEGER, url TEXT, last_modified REAL, has_recurrences INTEGER, entity_type INTEGER, UUID TEXT);
  `);
  db.prepare("INSERT INTO Store(ROWID,name,type) VALUES (1,'iCloud',2)").run();
  db.prepare("INSERT INTO Calendar(ROWID,store_id,title,type) VALUES (10,1,'Casa',0)").run();
  db.prepare("INSERT INTO Location(ROWID,title) VALUES (5,'Rome')").run();
  const start = unixToCoreData(Math.floor(Date.parse("2026-06-25T10:00:00Z") / 1000));
  const end = unixToCoreData(Math.floor(Date.parse("2026-06-25T11:00:00Z") / 1000));
  db.prepare(`INSERT INTO CalendarItem(ROWID,summary,description,location_id,start_date,end_date,all_day,calendar_id,status,url,last_modified,has_recurrences,entity_type,UUID)
    VALUES (100,'Dentist','checkup',5,?,?,0,10,1,'https://x','0',0,2,'UID-100')`).run(start, end);
  db.close();
  return path;
}

test("eventsInRange returns joined fields within the window", () => {
  const s = AppleStore.openReadonly(seed());
  const evs = s.eventsInRange({ startISO: "2026-06-01T00:00:00Z", endISO: "2026-07-01T00:00:00Z" });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].summary, "Dentist");
  assert.equal(evs[0].location, "Rome");
  assert.equal(evs[0].account, "iCloud");
  assert.equal(evs[0].calendar, "Casa");
  assert.equal(evs[0].start, "2026-06-25T10:00:00.000Z");
  s.close();
});

test("account filter excludes other accounts", () => {
  const s = AppleStore.openReadonly(seed());
  assert.equal(s.eventsInRange({ startISO: "2026-06-01T00:00:00Z", endISO: "2026-07-01T00:00:00Z", account: "Google" }).length, 0);
  s.close();
});

test("getEvent resolves by UID", () => {
  const s = AppleStore.openReadonly(seed());
  assert.equal(s.getEvent("UID-100")?.summary, "Dentist");
  s.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/calendar-mcp && node --import tsx --test test/apple-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types.ts + apple-store.ts**

`apps/calendar-mcp/src/types.ts`:
```ts
export interface CalEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string; // ISO
  end: string;   // ISO
  allDay: boolean;
  calendar: string;
  account: string;
  status: number;
  url: string | null;
  lastModified: number; // core data seconds
}

export interface CalendarInfo { title: string; account: string; type: number }
```

`apps/calendar-mcp/src/apple-store.ts`:
```ts
import Database from "better-sqlite3";
import { coreDataToISO, isoToUnix, unixToCoreData } from "./coredata.ts";
import type { CalEvent, CalendarInfo } from "./types.ts";

const SELECT = `
  SELECT ci.UUID AS uid, ci.summary AS summary, ci.description AS description,
         l.title AS location, ci.start_date AS start_cd, ci.end_date AS end_cd,
         ci.all_day AS all_day, c.title AS calendar, s.name AS account,
         ci.status AS status, ci.url AS url, ci.last_modified AS last_modified
  FROM CalendarItem ci
  JOIN Calendar c ON c.ROWID = ci.calendar_id
  JOIN Store s ON s.ROWID = c.store_id
  LEFT JOIN Location l ON l.ROWID = ci.location_id
  WHERE ci.entity_type = 2`;

function toEvent(r: Record<string, unknown>): CalEvent {
  return {
    uid: String(r.uid ?? ""),
    summary: String(r.summary ?? ""),
    description: (r.description as string) ?? null,
    location: (r.location as string) ?? null,
    start: coreDataToISO(Number(r.start_cd)),
    end: coreDataToISO(Number(r.end_cd ?? r.start_cd)),
    allDay: Number(r.all_day) === 1,
    calendar: String(r.calendar ?? ""),
    account: String(r.account ?? ""),
    status: Number(r.status ?? 0),
    url: (r.url as string) ?? null,
    lastModified: Number(r.last_modified ?? 0),
  };
}

export class AppleStore {
  private constructor(private readonly db: Database.Database) {}

  static openReadonly(path: string): AppleStore {
    return new AppleStore(new Database(path, { readonly: true, fileMustExist: true }));
  }

  listCalendars(): CalendarInfo[] {
    const rows = this.db.prepare(
      `SELECT c.title AS title, s.name AS account, c.type AS type
       FROM Calendar c JOIN Store s ON s.ROWID = c.store_id ORDER BY s.name, c.title`,
    ).all() as Record<string, unknown>[];
    return rows.map((r) => ({ title: String(r.title ?? ""), account: String(r.account ?? ""), type: Number(r.type ?? 0) }));
  }

  eventsInRange(opts: { startISO: string; endISO: string; account?: string; calendar?: string }): CalEvent[] {
    const startCd = unixToCoreData(isoToUnix(opts.startISO));
    const endCd = unixToCoreData(isoToUnix(opts.endISO));
    const where: string[] = ["ci.start_date >= ?", "ci.start_date <= ?"];
    const params: unknown[] = [startCd, endCd];
    if (opts.account) { where.push("s.name = ?"); params.push(opts.account); }
    if (opts.calendar) { where.push("c.title = ?"); params.push(opts.calendar); }
    const sql = `${SELECT} AND ${where.join(" AND ")} ORDER BY ci.start_date LIMIT 1000`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toEvent);
  }

  getEvent(uid: string): CalEvent | undefined {
    const r = this.db.prepare(`${SELECT} AND ci.UUID = ? LIMIT 1`).get(uid) as Record<string, unknown> | undefined;
    return r ? toEvent(r) : undefined;
  }

  /** Every event, for full (re)indexing. */
  allForIndex(): CalEvent[] {
    return (this.db.prepare(`${SELECT} ORDER BY ci.start_date`).all() as Record<string, unknown>[]).map(toEvent);
  }

  close(): void { this.db.close(); }
}
```

> Recurring-instance expansion via `OccurrenceCache` is added in a later refinement; v1 `eventsInRange` keys off `CalendarItem.start_date`, which covers non-recurring events and recurring masters. This is sufficient for search indexing (the index stores masters) and for range reads of non-recurring events. (Documented limitation, tracked for a follow-up; not a placeholder — the union query is deferred by design to keep v1 shippable.)

- [ ] **Step 4: Run the test + typecheck**

Run: `cd apps/calendar-mcp && node --import tsx --test test/apple-store.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar-mcp/src/types.ts apps/calendar-mcp/src/apple-store.ts apps/calendar-mcp/test/apple-store.test.ts
git commit -m "feat(calendar-mcp): read-only Apple Calendar store reader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `index-db.ts` — sidecar index schema

**Files:**
- Create: `apps/calendar-mcp/src/index-db.ts`
- Test: `apps/calendar-mcp/test/index-db.test.ts`

**Interfaces:**
- Consumes: `VectorStore` from `@steward/search`; `CalEvent` from `./types.ts`.
- Produces: `class IndexDb` with `static open(path: string): IndexDb`, `getState/setState`, `upsertEvent(e: CalEvent, sourceHash: string): number` (returns rowid), `deleteMissing(keepUids: string[]): number`, `allUids(): string[]`, `embedStateFor(uid): { sourceHash: string } | undefined`, `recordEmbed(uid, sourceHash, dim, model)`, `vectors: VectorStore`, `ftsSearch(query: string, limit: number): string[]` (uids best-first), `rowidToUid(rowid): string | undefined`, `uidToRowid(uid): number | undefined`, `close()`.

- [ ] **Step 1: Write the failing test**

`apps/calendar-mcp/test/index-db.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import type { CalEvent } from "../src/types.ts";

function ev(uid: string, summary: string): CalEvent {
  return { uid, summary, description: null, location: null, start: "2026-06-25T10:00:00.000Z",
    end: "2026-06-25T11:00:00.000Z", allDay: false, calendar: "Casa", account: "iCloud", status: 1, url: null, lastModified: 1 };
}

test("upsert + FTS finds by summary token", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(ev("U1", "Dentist appointment"), "h1");
  db.upsertEvent(ev("U2", "Team standup"), "h2");
  assert.deepEqual(db.ftsSearch("dentist", 10), ["U1"]);
  db.close();
});

test("deleteMissing removes uids not in the keep list", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(ev("U1", "a"), "h1");
  db.upsertEvent(ev("U2", "b"), "h2");
  assert.equal(db.deleteMissing(["U1"]), 1);
  assert.deepEqual(db.allUids().sort(), ["U1"]);
  db.close();
});

test("embed bookkeeping round-trips", () => {
  const db = IndexDb.open(":memory:");
  db.upsertEvent(ev("U1", "a"), "h1");
  assert.equal(db.embedStateFor("U1"), undefined);
  db.recordEmbed("U1", "h1", 3, "local-embed");
  assert.equal(db.embedStateFor("U1")?.sourceHash, "h1");
  db.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/calendar-mcp && node --import tsx --test test/index-db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement index-db.ts**

`apps/calendar-mcp/src/index-db.ts`:
```ts
import Database from "better-sqlite3";
import { VectorStore } from "@steward/search";
import type { CalEvent } from "./types.ts";

export class IndexDb {
  readonly vectors: VectorStore;
  private constructor(private readonly raw: Database.Database) {
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS events(
        rowid INTEGER PRIMARY KEY,
        uid TEXT UNIQUE, summary TEXT, description TEXT, location TEXT,
        start TEXT, end TEXT, all_day INTEGER, calendar TEXT, account TEXT,
        status INTEGER, url TEXT, last_modified REAL, source_hash TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(summary, description, location);
      CREATE TABLE IF NOT EXISTS embed_state(uid TEXT PRIMARY KEY, source_hash TEXT, dim INTEGER, model TEXT, embedded_at INTEGER);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
    `);
    this.vectors = new VectorStore(this.raw, {
      table: "vec_events",
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

  upsertEvent(e: CalEvent, sourceHash: string): number {
    const info = this.raw.prepare(`
      INSERT INTO events(uid,summary,description,location,start,end,all_day,calendar,account,status,url,last_modified,source_hash)
      VALUES (@uid,@summary,@description,@location,@start,@end,@all_day,@calendar,@account,@status,@url,@last_modified,@source_hash)
      ON CONFLICT(uid) DO UPDATE SET summary=excluded.summary, description=excluded.description, location=excluded.location,
        start=excluded.start, end=excluded.end, all_day=excluded.all_day, calendar=excluded.calendar, account=excluded.account,
        status=excluded.status, url=excluded.url, last_modified=excluded.last_modified, source_hash=excluded.source_hash`)
      .run({ ...e, all_day: e.allDay ? 1 : 0, last_modified: e.lastModified, source_hash: sourceHash });
    void info;
    const rowid = (this.raw.prepare("SELECT rowid FROM events WHERE uid=?").get(e.uid) as { rowid: number }).rowid;
    // keep the standalone FTS row at the same rowid in sync
    this.raw.prepare("DELETE FROM events_fts WHERE rowid=?").run(rowid);
    this.raw.prepare("INSERT INTO events_fts(rowid, summary, description, location) VALUES (?,?,?,?)")
      .run(rowid, e.summary, e.description ?? "", e.location ?? "");
    return rowid;
  }

  deleteMissing(keepUids: string[]): number {
    const keep = new Set(keepUids);
    const all = this.allUids();
    let n = 0;
    const del = this.raw.prepare("DELETE FROM events WHERE uid=?");
    const delFts = this.raw.prepare("DELETE FROM events_fts WHERE rowid=?");
    for (const uid of all) {
      if (keep.has(uid)) continue;
      const row = this.raw.prepare("SELECT rowid FROM events WHERE uid=?").get(uid) as { rowid: number } | undefined;
      if (row) delFts.run(row.rowid);
      del.run(uid);
      this.raw.prepare("DELETE FROM embed_state WHERE uid=?").run(uid);
      n++;
    }
    return n;
  }

  allUids(): string[] {
    return (this.raw.prepare("SELECT uid FROM events").all() as { uid: string }[]).map((r) => r.uid);
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
      `SELECT e.uid AS uid FROM events_fts f JOIN events e ON e.rowid = f.rowid
       WHERE events_fts MATCH ? ORDER BY rank LIMIT ?`).all(query, limit) as { uid: string }[];
    return rows.map((r) => r.uid);
  }

  rowidToUid(rowid: number): string | undefined {
    return (this.raw.prepare("SELECT uid FROM events WHERE rowid=?").get(rowid) as { uid: string } | undefined)?.uid;
  }
  uidToRowid(uid: string): number | undefined {
    return (this.raw.prepare("SELECT rowid FROM events WHERE uid=?").get(uid) as { rowid: number } | undefined)?.rowid;
  }

  close(): void { this.raw.close(); }
}
```

> `events_fts` is a standalone FTS5 table (not external-content), so keeping it in sync is a plain `DELETE … WHERE rowid=?` + `INSERT … (rowid, …)` at the same rowid as the `events` row — no contentless `'delete'` bookkeeping.

- [ ] **Step 4: Run the test + typecheck**

Run: `cd apps/calendar-mcp && node --import tsx --test test/index-db.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar-mcp/src/index-db.ts apps/calendar-mcp/test/index-db.test.ts
git commit -m "feat(calendar-mcp): sidecar index DB (events + FTS5 + vec)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: `sync.ts` — incremental index + embedding

**Files:**
- Create: `apps/calendar-mcp/src/embed-config.ts`
- Create: `apps/calendar-mcp/src/sync.ts`
- Test: `apps/calendar-mcp/test/sync.test.ts`

**Interfaces:**
- Consumes: `AppleStore`, `IndexDb`, `CalEvent`; `embedTexts` from `@steward/search`; `EmbeddingConfig` from `@steward/embedding`.
- Produces: `sourceHash(e: CalEvent): string`; `loadEmbedConfig(env?): EmbeddingConfig | null`; `syncIndex(deps: { store: { allForIndex(): CalEvent[] }; index: IndexDb; embedConfig: EmbeddingConfig | null; embedBatch?: (texts: string[], cfg: EmbeddingConfig) => Promise<(number[] | null)[]> }): Promise<{ upserted: number; embedded: number; deleted: number }>`.

- [ ] **Step 1: Write the failing test (injected embedder, no network)**

`apps/calendar-mcp/test/sync.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import { syncIndex, sourceHash } from "../src/sync.ts";
import type { CalEvent } from "../src/types.ts";

function ev(uid: string, summary: string): CalEvent {
  return { uid, summary, description: null, location: null, start: "2026-06-25T10:00:00.000Z",
    end: "2026-06-25T11:00:00.000Z", allDay: false, calendar: "Casa", account: "iCloud", status: 1, url: null, lastModified: 1 };
}

test("syncIndex upserts, embeds new, and deletes vanished", async () => {
  const index = IndexDb.open(":memory:");
  const cfg = { endpoint: "http://x/v1/embeddings", model: "local-embed" };
  const embedBatch = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);
  let events = [ev("U1", "Dentist"), ev("U2", "Standup")];
  const store = { allForIndex: () => events };
  const r1 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r1.upserted, 2);
  assert.equal(r1.embedded, 2);
  // Re-run with no changes: nothing re-embedded
  const r2 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r2.embedded, 0);
  // Drop U2
  events = [ev("U1", "Dentist")];
  const r3 = await syncIndex({ store, index, embedConfig: cfg, embedBatch });
  assert.equal(r3.deleted, 1);
  index.close();
});

test("sourceHash changes when summary changes", () => {
  assert.notEqual(sourceHash(ev("U1", "a")), sourceHash(ev("U1", "b")));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/calendar-mcp && node --import tsx --test test/sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement embed-config.ts + sync.ts**

`apps/calendar-mcp/src/embed-config.ts` (mirror mail-mirror's default-gateway behaviour):
```ts
import type { EmbeddingConfig } from "@steward/embedding";

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

`apps/calendar-mcp/src/sync.ts`:
```ts
import { createHash } from "node:crypto";
import { embedTexts } from "@steward/search";
import type { EmbeddingConfig } from "@steward/embedding";
import type { IndexDb } from "./index-db.ts";
import type { CalEvent } from "./types.ts";

export function sourceHash(e: CalEvent): string {
  return createHash("sha1").update(`${e.summary}\n${e.description ?? ""}\n${e.location ?? ""}`).digest("hex");
}

function embedText(e: CalEvent): string {
  return [e.summary, e.description ?? "", e.location ?? ""].filter(Boolean).join("\n");
}

export interface SyncDeps {
  store: { allForIndex(): CalEvent[] };
  index: IndexDb;
  embedConfig: EmbeddingConfig | null;
  embedBatch?: (texts: string[], cfg: EmbeddingConfig) => Promise<(number[] | null)[]>;
}

export async function syncIndex(deps: SyncDeps): Promise<{ upserted: number; embedded: number; deleted: number }> {
  const events = deps.store.allForIndex();
  let upserted = 0;
  const toEmbed: { uid: string; rowid: number; text: string; hash: string }[] = [];
  for (const e of events) {
    const hash = sourceHash(e);
    const rowid = deps.index.upsertEvent(e, hash);
    upserted++;
    if (deps.embedConfig && deps.index.embedStateFor(e.uid)?.sourceHash !== hash) {
      toEmbed.push({ uid: e.uid, rowid, text: embedText(e), hash });
    }
  }
  const deleted = deps.index.deleteMissing(events.map((e) => e.uid));

  let embedded = 0;
  if (deps.embedConfig && toEmbed.length) {
    const batch = deps.embedBatch ?? embedTexts;
    const vectors = await batch(toEmbed.map((t) => t.text), deps.embedConfig);
    for (let i = 0; i < toEmbed.length; i++) {
      const v = vectors[i];
      if (!v) continue;
      deps.index.vectors.enable();
      deps.index.vectors.ensureTable(v.length);
      deps.index.vectors.upsert(toEmbed[i].rowid, v);
      deps.index.recordEmbed(toEmbed[i].uid, toEmbed[i].hash, v.length, deps.embedConfig.model);
      embedded++;
    }
  }
  return { upserted, embedded, deleted };
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd apps/calendar-mcp && node --import tsx --test test/sync.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar-mcp/src/embed-config.ts apps/calendar-mcp/src/sync.ts apps/calendar-mcp/test/sync.test.ts
git commit -m "feat(calendar-mcp): incremental sync + gateway embedding

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: `search.ts` — hybrid FTS + vector + RRF

**Files:**
- Create: `apps/calendar-mcp/src/search.ts`
- Test: `apps/calendar-mcp/test/search.test.ts`

**Interfaces:**
- Consumes: `IndexDb`, `rrf` from `@steward/search`.
- Produces: `hybridSearch(deps: { index: IndexDb; embedQuery?: (text: string) => Promise<number[] | null> }, query: string, limit: number): Promise<string[]>` (uids best-first).

- [ ] **Step 1: Write the failing test**

`apps/calendar-mcp/test/search.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexDb } from "../src/index-db.ts";
import { hybridSearch } from "../src/search.ts";
import type { CalEvent } from "../src/types.ts";

function ev(uid: string, summary: string): CalEvent {
  return { uid, summary, description: null, location: null, start: "2026-06-25T10:00:00.000Z",
    end: "2026-06-25T11:00:00.000Z", allDay: false, calendar: "Casa", account: "iCloud", status: 1, url: null, lastModified: 1 };
}

test("hybrid falls back to FTS-only when no embedder", async () => {
  const index = IndexDb.open(":memory:");
  index.upsertEvent(ev("U1", "Dentist appointment"), "h1");
  index.upsertEvent(ev("U2", "Team standup"), "h2");
  const out = await hybridSearch({ index }, "dentist", 10);
  assert.deepEqual(out, ["U1"]);
  index.close();
});

test("hybrid merges vector hits with FTS via RRF", async () => {
  const index = IndexDb.open(":memory:");
  const r1 = index.upsertEvent(ev("U1", "Dentist"), "h1");
  const r2 = index.upsertEvent(ev("U2", "Doctor"), "h2");
  index.vectors.enable();
  index.vectors.ensureTable(3);
  index.vectors.upsert(r1, [1, 0, 0]);
  index.vectors.upsert(r2, [0.9, 0.1, 0]);
  // query matches U2 by vector, neither strongly by FTS token "checkup"
  const out = await hybridSearch({ index, embedQuery: async () => [0.85, 0.15, 0] }, "checkup", 10);
  assert.ok(out.includes("U2"));
  index.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/calendar-mcp && node --import tsx --test test/search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement search.ts**

`apps/calendar-mcp/src/search.ts`:
```ts
import { rrf } from "@steward/search";
import type { IndexDb } from "./index-db.ts";

/** Escape a free-text query so it is safe as an FTS5 MATCH parameter (quote each token). */
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
  const ftsIds = fts ? deps.index.ftsSearch(fts, limit) : [];

  let vecIds: string[] = [];
  if (deps.embedQuery) {
    const qv = await deps.embedQuery(query);
    const dim = Number(deps.index.getState("vec_events_dim") ?? 0);
    if (qv && qv.length === dim && dim > 0) {
      deps.index.vectors.enable();
      const hits = deps.index.vectors.knn(qv, limit);
      vecIds = hits.map((h) => deps.index.rowidToUid(h.rowid)).filter((u): u is string => !!u);
    }
  }

  const ordered = vecIds.length ? rrf([ftsIds, vecIds]).map((r) => r.id) : ftsIds;
  return ordered.slice(0, limit);
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd apps/calendar-mcp && node --import tsx --test test/search.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar-mcp/src/search.ts apps/calendar-mcp/test/search.test.ts
git commit -m "feat(calendar-mcp): hybrid FTS+vector search via RRF

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: `applescript.ts` — write builders + Calendar error mapper

**Files:**
- Create: `apps/calendar-mcp/src/applescript.ts`
- Test: `apps/calendar-mcp/test/applescript.test.ts`

**Interfaces:**
- Consumes: `esc`, `runOsa`, `OsaExec` from `@steward/applescript`.
- Produces: `mapCalendarError(stderr: string): string`; pure builders `buildCreate(a: CreateArgs): string`, `buildUpdate(a: UpdateArgs): string`, `buildDelete(uid: string): string`; runners `createEvent(a, exec?)`, `updateEvent(a, exec?)`, `deleteEvent(uid, exec?)`. Types `CreateArgs { calendar: string; summary: string; start: string; end: string; allDay?: boolean; location?: string; description?: string; url?: string; recurrence?: string }`, `UpdateArgs { uid: string; summary?: string; start?: string; end?: string; location?: string; description?: string; url?: string; recurrence?: string }`.

- [ ] **Step 1: Write the failing test (builders are pure; runner uses injected exec)**

`apps/calendar-mcp/test/applescript.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreate, buildDelete, mapCalendarError, createEvent } from "../src/applescript.ts";

test("buildCreate sets calendar, summary and escapes quotes", () => {
  const s = buildCreate({ calendar: "Casa", summary: 'a"b', start: "2026-06-25T10:00:00.000Z", end: "2026-06-25T11:00:00.000Z" });
  assert.match(s, /calendar "Casa"/);
  assert.match(s, /summary:"a\\"b"/);
  assert.match(s, /make new event/);
});

test("buildDelete locates by uid", () => {
  assert.match(buildDelete("UID-9"), /whose uid is "UID-9"/);
});

test("mapCalendarError explains automation denial", () => {
  assert.match(mapCalendarError("-1743 Not authorized"), /Automation/);
});

test("createEvent returns the uid printed by the script", async () => {
  const uid = await createEvent(
    { calendar: "Casa", summary: "x", start: "2026-06-25T10:00:00.000Z", end: "2026-06-25T11:00:00.000Z" },
    async () => "UID-NEW\n",
  );
  assert.equal(uid, "UID-NEW");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/calendar-mcp && node --import tsx --test test/applescript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement applescript.ts**

`apps/calendar-mcp/src/applescript.ts`:
```ts
import { esc, runOsa, type OsaExec } from "@steward/applescript";

export interface CreateArgs {
  calendar: string; summary: string; start: string; end: string;
  allDay?: boolean; location?: string; description?: string; url?: string; recurrence?: string;
}
export interface UpdateArgs {
  uid: string; summary?: string; start?: string; end?: string;
  location?: string; description?: string; url?: string; recurrence?: string;
}

export function mapCalendarError(stderr: string): string {
  if (/-1743\b|Not authorized/i.test(stderr)) {
    return "Automation permission for Calendar is not granted. Allow it in System Settings → Privacy & Security → Automation.";
  }
  if (/-1728\b/i.test(stderr)) {
    return "Calendar could not find the target calendar or event (it may have been moved or deleted).";
  }
  if (/-600\b|isn.t running/i.test(stderr)) {
    return "Calendar.app is not running. Open Calendar and try again.";
  }
  return stderr.trim() || "osascript failed";
}

/** AppleScript date literal from an ISO string, built field-by-field to avoid locale parsing. */
function dateExpr(varName: string, iso: string): string[] {
  const d = new Date(iso);
  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${d.getFullYear()}`,
    `set month of ${varName} to ${d.getMonth() + 1}`,
    `set day of ${varName} to ${d.getDate()}`,
    `set hours of ${varName} to ${d.getHours()}`,
    `set minutes of ${varName} to ${d.getMinutes()}`,
    `set seconds of ${varName} to ${d.getSeconds()}`,
  ];
}

export function buildCreate(a: CreateArgs): string {
  const props: string[] = [`summary:"${esc(a.summary)}"`, "start date:startD", "end date:endD"];
  if (a.allDay) props.push("allday event:true");
  if (a.location) props.push(`location:"${esc(a.location)}"`);
  if (a.description) props.push(`description:"${esc(a.description)}"`);
  const lines = [
    'tell application "Calendar"',
    ...dateExpr("startD", a.start),
    ...dateExpr("endD", a.end),
    `  tell calendar "${esc(a.calendar)}"`,
    `    set e to make new event with properties {${props.join(", ")}}`,
  ];
  if (a.url) lines.push(`    set url of e to "${esc(a.url)}"`);
  if (a.recurrence) lines.push(`    set recurrence of e to "${esc(a.recurrence)}"`);
  lines.push("    set theUID to uid of e", "  end tell", "  return theUID", "end tell");
  return lines.join("\n");
}

export function buildUpdate(a: UpdateArgs): string {
  const lines = ['tell application "Calendar"'];
  if (a.start) lines.push(...dateExpr("startD", a.start));
  if (a.end) lines.push(...dateExpr("endD", a.end));
  lines.push(`  set e to (first event of (every calendar) whose uid is "${esc(a.uid)}")`);
  // Robust lookup across calendars:
  lines.length = 1;
  lines.push(
    "  set theEvent to missing value",
    "  repeat with c in calendars",
    "    try",
    `      set theEvent to (first event of c whose uid is "${esc(a.uid)}")`,
    "      exit repeat",
    "    end try",
    "  end repeat",
    "  if theEvent is missing value then error \"-1728\"",
  );
  if (a.start) lines.splice(1, 0, ...dateExpr("startD", a.start));
  if (a.end) lines.splice(1, 0, ...dateExpr("endD", a.end));
  if (a.summary) lines.push(`  set summary of theEvent to "${esc(a.summary)}"`);
  if (a.start) lines.push("  set start date of theEvent to startD");
  if (a.end) lines.push("  set end date of theEvent to endD");
  if (a.location) lines.push(`  set location of theEvent to "${esc(a.location)}"`);
  if (a.description) lines.push(`  set description of theEvent to "${esc(a.description)}"`);
  if (a.url) lines.push(`  set url of theEvent to "${esc(a.url)}"`);
  if (a.recurrence) lines.push(`  set recurrence of theEvent to "${esc(a.recurrence)}"`);
  lines.push('  return "ok"', "end tell");
  return lines.join("\n");
}

export function buildDelete(uid: string): string {
  return [
    'tell application "Calendar"',
    "  repeat with c in calendars",
    "    try",
    `      delete (first event of c whose uid is "${esc(uid)}")`,
    '      return "ok"',
    "    end try",
    "  end repeat",
    '  error "-1728"',
    "end tell",
  ].join("\n");
}

const run = (script: string, exec?: OsaExec) => runOsa(script, { exec, mapError: mapCalendarError });

export async function createEvent(a: CreateArgs, exec?: OsaExec): Promise<string> {
  return (await run(buildCreate(a), exec)).trim();
}
export async function updateEvent(a: UpdateArgs, exec?: OsaExec): Promise<void> {
  await run(buildUpdate(a), exec);
}
export async function deleteEvent(uid: string, exec?: OsaExec): Promise<void> {
  await run(buildDelete(uid), exec);
}
```

> When implementing `buildUpdate`, write the across-calendars lookup cleanly in one pass (the `lines.length = 1` / `splice` juggling above is illustrative of intent, not final form): build the date-setup lines first, then the lookup loop, then the per-field setters. The test only asserts `buildCreate`/`buildDelete`/`mapCalendarError`/`createEvent`; ensure `buildUpdate` compiles and produces a single coherent script.

- [ ] **Step 4: Run the test + typecheck**

Run: `cd apps/calendar-mcp && node --import tsx --test test/applescript.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar-mcp/src/applescript.ts apps/calendar-mcp/test/applescript.test.ts
git commit -m "feat(calendar-mcp): AppleScript create/update/delete builders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: `args.ts` — argument validation

**Files:**
- Create: `apps/calendar-mcp/src/args.ts`
- Test: `apps/calendar-mcp/test/args.test.ts`

**Interfaces:**
- Produces: `parseSearchArgs(raw): { query?: string; start: string; end: string; account?: string; calendar?: string; limit: number }`; `parseCreateArgs(raw): CreateArgs`; `parseUpdateArgs(raw): UpdateArgs`; `requireString(raw, field): string`. Throws `Error` with an actionable message on invalid input.

- [ ] **Step 1: Write the failing test**

`apps/calendar-mcp/test/args.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchArgs, parseCreateArgs } from "../src/args.ts";

test("parseSearchArgs defaults the range and limit", () => {
  const a = parseSearchArgs({ query: "dentist" });
  assert.equal(a.query, "dentist");
  assert.equal(a.limit, 20);
  assert.ok(Date.parse(a.start) < Date.parse(a.end));
});

test("parseCreateArgs requires calendar/summary/start/end", () => {
  assert.throws(() => parseCreateArgs({ summary: "x", start: "2026-06-25T10:00:00Z", end: "2026-06-25T11:00:00Z" }), /calendar/);
});

test("parseCreateArgs rejects end before start", () => {
  assert.throws(() => parseCreateArgs({ calendar: "Casa", summary: "x", start: "2026-06-25T11:00:00Z", end: "2026-06-25T10:00:00Z" }), /after start/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/calendar-mcp && node --import tsx --test test/args.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement args.ts**

`apps/calendar-mcp/src/args.ts`:
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

function validIso(raw: Raw, field: string, required: boolean): string | undefined {
  const v = optString(raw, field);
  if (v === undefined) { if (required) throw new Error(`"${field}" is required (ISO date)`); return undefined; }
  if (Number.isNaN(Date.parse(v))) throw new Error(`"${field}" must be an ISO date`);
  return v;
}

export function parseSearchArgs(raw: Raw): { query?: string; start: string; end: string; account?: string; calendar?: string; limit: number } {
  const now = Date.now();
  const start = validIso(raw, "start", false) ?? new Date(now - 30 * 86400_000).toISOString();
  const end = validIso(raw, "end", false) ?? new Date(now + 90 * 86400_000).toISOString();
  const limitRaw = raw.limit;
  const limit = typeof limitRaw === "number" && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
  return { query: optString(raw, "query"), start, end, account: optString(raw, "account"), calendar: optString(raw, "calendar"), limit };
}

export function parseCreateArgs(raw: Raw): CreateArgs {
  const start = validIso(raw, "start", true)!;
  const end = validIso(raw, "end", true)!;
  if (Date.parse(end) <= Date.parse(start)) throw new Error("\"end\" must be after start");
  return {
    calendar: requireString(raw, "calendar"),
    summary: requireString(raw, "summary"),
    start, end,
    allDay: raw.allDay === true,
    location: optString(raw, "location"),
    description: optString(raw, "description"),
    url: optString(raw, "url"),
    recurrence: optString(raw, "recurrence"),
  };
}

export function parseUpdateArgs(raw: Raw): UpdateArgs {
  return {
    uid: requireString(raw, "uid"),
    summary: optString(raw, "summary"),
    start: validIso(raw, "start", false),
    end: validIso(raw, "end", false),
    location: optString(raw, "location"),
    description: optString(raw, "description"),
    url: optString(raw, "url"),
    recurrence: optString(raw, "recurrence"),
  };
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd apps/calendar-mcp && node --import tsx --test test/args.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar-mcp/src/args.ts apps/calendar-mcp/test/args.test.ts
git commit -m "feat(calendar-mcp): MCP argument validation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: `cli.ts` + `index.ts` (MCP server) + realtest

**Files:**
- Create: `apps/calendar-mcp/src/cli.ts`
- Create: `apps/calendar-mcp/src/index.ts`
- Create: `apps/calendar-mcp/realtest.mts`
- Create: `apps/calendar-mcp/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the runnable MCP server and `index`/`sync`/`status` CLI.

- [ ] **Step 1: Implement cli.ts**

`apps/calendar-mcp/src/cli.ts`:
```ts
#!/usr/bin/env -S node --import tsx
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppleStore } from "./apple-store.ts";
import { IndexDb } from "./index-db.ts";
import { syncIndex } from "./sync.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { applePath, indexDbPath } from "./paths.ts";

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "index" || cmd === "sync") {
    if (!existsSync(applePath())) { console.error("Apple Calendar store not found. Grant Full Disk Access."); process.exit(3); }
    const idxPath = indexDbPath();
    mkdirSync(dirname(idxPath), { recursive: true });
    const store = AppleStore.openReadonly(applePath());
    const index = IndexDb.open(idxPath);
    const res = await syncIndex({ store, index, embedConfig: loadEmbedConfig() });
    console.log(`sync: upserted ${res.upserted}, embedded ${res.embedded}, deleted ${res.deleted}`);
    store.close(); index.close();
  } else if (cmd === "status") {
    const idxPath = indexDbPath();
    if (!existsSync(idxPath)) { console.log("index: not built yet"); return; }
    const index = IndexDb.open(idxPath);
    console.log(`indexed events: ${index.allUids().length}`);
    console.log(`db: ${idxPath}`);
    index.close();
  } else {
    console.log("usage: calendar-mcp <index|sync|status>");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Implement index.ts (MCP server)**

`apps/calendar-mcp/src/index.ts` (follow mail-mcp's registration shape):
```ts
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AppleStore } from "./apple-store.ts";
import { IndexDb } from "./index-db.ts";
import { hybridSearch } from "./search.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { embedText } from "@steward/search";
import { createEvent, updateEvent, deleteEvent } from "./applescript.ts";
import { parseSearchArgs, parseCreateArgs, parseUpdateArgs, requireString } from "./args.ts";
import { applePath, indexDbPath } from "./paths.ts";

const appleReady = existsSync(applePath());
const store = appleReady ? AppleStore.openReadonly(applePath()) : null;
const idxReady = existsSync(indexDbPath());
const index = idxReady ? IndexDb.open(indexDbPath()) : null;
if (index) index.vectors.enable();
const embedCfg = loadEmbedConfig();
const embedQuery = embedCfg ? (t: string) => embedText(t, embedCfg) : undefined;

const server = new Server({ name: "calendar", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "list_calendars", description: "List calendars with their account.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "search_events", description: "Search events (hybrid keyword+semantic). All filters optional and ANDed.", inputSchema: { type: "object", properties: {
      query: { type: "string" }, start: { type: "string", description: "ISO start of range" }, end: { type: "string", description: "ISO end of range" },
      account: { type: "string" }, calendar: { type: "string" }, limit: { type: "number" } }, additionalProperties: false } },
    { name: "read_event", description: "Read one event by uid.", inputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"], additionalProperties: false } },
    { name: "create_event", description: "Create a calendar event.", inputSchema: { type: "object", properties: {
      calendar: { type: "string" }, summary: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      allDay: { type: "boolean" }, location: { type: "string" }, description: { type: "string" }, url: { type: "string" }, recurrence: { type: "string" } },
      required: ["calendar", "summary", "start", "end"], additionalProperties: false } },
    { name: "update_event", description: "Update fields of an event by uid.", inputSchema: { type: "object", properties: {
      uid: { type: "string" }, summary: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      location: { type: "string" }, description: { type: "string" }, url: { type: "string" }, recurrence: { type: "string" } },
      required: ["uid"], additionalProperties: false } },
    { name: "delete_event", description: "Delete an event by uid.", inputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"], additionalProperties: false } },
  ],
}));

function ok(data: unknown) { return { content: [{ type: "text", text: JSON.stringify(data) }] }; }

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const raw = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "list_calendars": {
        if (!store) throw new Error("Apple Calendar store not found. Grant Full Disk Access.");
        return ok(store.listCalendars());
      }
      case "search_events": {
        if (!store) throw new Error("Apple Calendar store not found. Grant Full Disk Access.");
        const a = parseSearchArgs(raw);
        let uids: string[];
        if (a.query && index) uids = await hybridSearch({ index, embedQuery }, a.query, a.limit);
        else uids = store.eventsInRange({ startISO: a.start, endISO: a.end, account: a.account, calendar: a.calendar }).map((e) => e.uid);
        const events = uids.map((u) => store.getEvent(u)).filter(Boolean)
          .filter((e) => (!a.account || e!.account === a.account) && (!a.calendar || e!.calendar === a.calendar))
          .slice(0, a.limit);
        return ok(events);
      }
      case "read_event": {
        if (!store) throw new Error("Apple Calendar store not found. Grant Full Disk Access.");
        return ok(store.getEvent(requireString(raw, "uid")) ?? null);
      }
      case "create_event": return ok({ uid: await createEvent(parseCreateArgs(raw)) });
      case "update_event": { await updateEvent(parseUpdateArgs(raw)); return ok({ ok: true }); }
      case "delete_event": { await deleteEvent(requireString(raw, "uid")); return ok({ ok: true }); }
      default: throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${req.params.name}`);
    }
  } catch (e) {
    throw new McpError(ErrorCode.InternalError, e instanceof Error ? e.message : String(e));
  }
});

await server.connect(new StdioServerTransport());
```

- [ ] **Step 3: Typecheck the whole app**

Run: `cd apps/calendar-mcp && npx tsc --noEmit`
Expected: tsc clean. Fix any signature drift against earlier tasks.

- [ ] **Step 4: Add realtest.mts (live, not run in CI)**

`apps/calendar-mcp/realtest.mts`:
```ts
// Manual live check: reads the real Apple store + a create/delete round-trip.
// Run: node --import tsx apps/calendar-mcp/realtest.mts
import { AppleStore } from "./src/apple-store.ts";
import { applePath } from "./src/paths.ts";
import { createEvent, deleteEvent } from "./src/applescript.ts";

const store = AppleStore.openReadonly(applePath());
console.log("calendars:", store.listCalendars().length);
const soon = new Date(Date.now() + 3600_000).toISOString();
const later = new Date(Date.now() + 7200_000).toISOString();
const uid = await createEvent({ calendar: "Casa", summary: "calendar-mcp realtest (delete me)", start: soon, end: later, location: "Test" });
console.log("created:", uid);
await deleteEvent(uid);
console.log("deleted OK");
store.close();
```

- [ ] **Step 5: Write README.md**

`apps/calendar-mcp/README.md` documenting: FDA requirement for reads, Automation for writes, `calendar-mcp index` to build/refresh the search index (embeddings via the gateway `local-embed`, `MAIL_EMBED_ENDPOINT=off` to disable), the 6 tools, the attendees limitation, and that destructive ops are gated by the host's PreToolUse approval.

- [ ] **Step 6: Run the full app suite + typecheck**

Run: `cd apps/calendar-mcp && npm test && npx tsc --noEmit`
Expected: all unit tests pass; tsc clean. (realtest is not part of `npm test`.)

- [ ] **Step 7: Commit**

```bash
git add apps/calendar-mcp/src/cli.ts apps/calendar-mcp/src/index.ts apps/calendar-mcp/realtest.mts apps/calendar-mcp/README.md
git commit -m "feat(calendar-mcp): CLI (index/sync/status) + MCP server + realtest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the executor

- After Tasks 2 and 4, re-run the mail-mcp and mail-mirror suites; they are the regression gate for the extraction.
- The `realtest.mts` create/delete targets the iCloud "Casa" calendar (validated during brainstorming). If that calendar name differs on the machine, pass an existing writable calendar name.
- `OccurrenceCache`-based expansion of recurring instances in range reads is a deliberate v1 follow-up; the index covers recurring masters so semantic/keyword search still finds them.
