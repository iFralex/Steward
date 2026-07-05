# Shared Embedding Package (Phase A of sub-project 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the wiki's embedding HTTP core into a pure shared workspace package `packages/embedding`, and migrate the wiki to consume it as a thin adapter with ZERO behaviour change — so mail (Phase B/C) can reuse the same embedding logic without duplication.

**Architecture:** A framework-agnostic ESM TS package exposes `fetchEmbedding(text, cfg, deps)` (provider request building, oversize auto-halve retry, parse, structured `{ vector, error }`) plus the pure provider helpers and the `EmbeddingConfig` type. All environment specifics (`fetch`, local-LLM origin header, network-error classifier) are injected. The wiki's `src/lib/embedding.ts` keeps its exact public API but delegates the HTTP core to the package, injecting Tauri's fetch/origin and mapping the structured result back to its existing `lastEmbeddingError` + `console.warn`.

**Tech Stack:** TypeScript (ESM), npm workspaces. Package tests: `node --import tsx --test`. Wiki tests: its existing **vitest** suite (the parity gate).

## Global Constraints

- `packages/embedding` is **pure ESM TypeScript** — NO Tauri, NO Node-only, NO React imports. Every environment specific (`fetch`, origin header, network-error check) is injected via a `deps` argument.
- **NON-NEGOTIABLE — llm-wiki parity:** the wiki's existing test suite (incl. `src/lib/embedding.test.ts`, 90 cases, and `embedding.real-llm.test.ts`) must pass **unmodified**. Error strings surfaced to Settings → Embedding must be **byte-identical** to today. Same HTTP requests, retry, vectors, storage calls. If parity cannot be preserved, STOP and report — do not alter wiki behaviour.
- Reuse over reimplement: move existing wiki functions verbatim where named; do not rewrite logic.
- `text-chunker` is NOT moved (only the wiki uses it; mail does not chunk). It stays in the wiki untouched.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; no apostrophes in heredoc commit bodies.

## File Structure

- `packages/embedding/package.json` — pure package manifest (`@steward/embedding`).
- `packages/embedding/tsconfig.json`
- `packages/embedding/src/types.ts` — `EmbeddingConfig`, `EmbeddingDeps`, `EmbeddingResult`.
- `packages/embedding/src/providers.ts` — provider detection + endpoint/body builders + classifiers (moved verbatim from the wiki).
- `packages/embedding/src/fetch-embedding.ts` — `fetchEmbedding(text, cfg, deps, maxRetries)`.
- `packages/embedding/src/index.ts` — re-exports.
- `packages/embedding/test/*.test.ts` — package tests (node --test).
- `apps/llm-wiki/src/lib/embedding.ts` — MODIFY: delegate the HTTP core to the package (adapter); keep the rest.
- Root `package.json` — add `packages/embedding` to `workspaces` if not glob-matched.

---

### Task 1: Scaffold `packages/embedding` + shared types

**Files:**
- Create: `packages/embedding/package.json`, `packages/embedding/tsconfig.json`, `packages/embedding/src/types.ts`, `packages/embedding/test/types.test.ts`
- Modify: root `package.json` (workspaces) if needed.

**Interfaces:**
- Produces: `EmbeddingConfig`, `EmbeddingDeps`, `EmbeddingResult` (consumed by A2/A3 and Phase B/C).

- [ ] **Step 1: Create the package manifest**

`packages/embedding/package.json`:
```json
{
  "name": "@steward/embedding",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create tsconfig**

`packages/embedding/tsconfig.json`:
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

- [ ] **Step 3: Define shared types**

`packages/embedding/src/types.ts`:
```ts
export interface EmbeddingConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  outputDimensionality?: number;
  extraHeaders?: Record<string, string>;
}

export interface EmbeddingDeps {
  /** Injected fetch (Tauri plugin fetch in the wiki, Node global fetch in mail). */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
  /** Optional local-LLM CORS origin header (wiki injects Tauri origin; mail omits). */
  originHeader?: () => Record<string, string>;
  /** Optional network-error classifier (wiki injects Tauri's; defaults to false). */
  isNetworkError?: (err: unknown) => boolean;
}

export interface EmbeddingResult {
  vector: number[] | null;
  /** Human-readable failure description, or undefined on success. Byte-identical to the wiki's strings. */
  error?: string;
}
```

- [ ] **Step 4: Write the smoke test**

`packages/embedding/test/types.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbeddingConfig, EmbeddingResult } from "../src/types.ts";

test("types are importable and shaped", () => {
  const cfg: EmbeddingConfig = { endpoint: "http://x/v1/embeddings", model: "m" };
  const r: EmbeddingResult = { vector: [0.1, 0.2] };
  assert.equal(cfg.model, "m");
  assert.equal(r.vector?.length, 2);
});
```

- [ ] **Step 5: Wire workspace, install, test**

Read the root `package.json` `workspaces`. If `packages/embedding` is not matched (it lists `packages/*` → already matched; otherwise add it). Run `npm install` from the repo root, then `cd packages/embedding && npm test`.
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/embedding/package.json packages/embedding/tsconfig.json packages/embedding/src/types.ts packages/embedding/test/types.test.ts package.json package-lock.json
git commit -m "feat(embedding): scaffold shared embedding package with types"
```

---

### Task 2: Move the pure provider helpers

**Files:**
- Create: `packages/embedding/src/providers.ts`, `packages/embedding/test/providers.test.ts`
- Source to copy from: `apps/llm-wiki/src/lib/embedding.ts` and `apps/llm-wiki/src/lib/llm-providers.ts`

**Interfaces:**
- Consumes: `EmbeddingConfig` (A1).
- Produces (all exported from `providers.ts`): `isGoogleEmbeddingConfig(cfg)`, `isDoubaoMultimodalEmbeddingConfig(cfg)`, `googleEmbeddingEndpoint(cfg)`, `volcengineEmbeddingEndpoint(cfg)`, `googleEmbeddingBody(model, text, outputDimensionality?)`, `doubaoMultimodalEmbeddingBody(model, text)`, `looksLikeOversizeError(status, body)`, `isNonEmptyNumberArray(v)`, `isSafeExtraHeader(name, value)`, `isLocalOrPrivateHttpEndpoint(endpoint)`.

- [ ] **Step 1: Copy the helper functions verbatim into `providers.ts`**

Move these functions **verbatim** from `apps/llm-wiki/src/lib/embedding.ts` (logic UNCHANGED), exporting each: `RESERVED_EMBEDDING_HEADER_NAMES`, `HTTP_HEADER_NAME_RE`, `isSafeExtraHeader`, `looksLikeOversizeError`, `isNonEmptyNumberArray`, `isGoogleEmbeddingConfig`, `isVolcengineEmbeddingEndpoint`, `isDoubaoMultimodalEmbeddingConfig`, `volcengineEmbeddingEndpoint`, `appendEndpointPath`, `googleEmbeddingEndpoint`, `stripGoogleApiKeyQuery`, `googleModelPath`, `googleEmbeddingBody`, `doubaoMultimodalEmbeddingBody`. Import `EmbeddingConfig` from `./types.ts`.

Then copy `isLocalOrPrivateHttpEndpoint` **verbatim** from `apps/llm-wiki/src/lib/llm-providers.ts` into `providers.ts` and export it. **Verify it has no Tauri/store imports** — if it references anything Tauri/store, STOP and report (it should be a pure URL/IP check). Do NOT copy `localLlmOriginHeader` (that is Tauri-specific and stays in the wiki).

- [ ] **Step 2: Write tests for the pure helpers**

`packages/embedding/test/providers.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isGoogleEmbeddingConfig, googleEmbeddingEndpoint, googleEmbeddingBody,
  looksLikeOversizeError, isNonEmptyNumberArray, isSafeExtraHeader, isLocalOrPrivateHttpEndpoint,
} from "../src/providers.ts";

test("openai-style config is not detected as google", () => {
  assert.equal(isGoogleEmbeddingConfig({ endpoint: "http://127.0.0.1:1234/v1/embeddings", model: "m" }), false);
});

test("google endpoint detection + embedContent URL", () => {
  const cfg = { endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "text-embedding-004" };
  assert.equal(isGoogleEmbeddingConfig(cfg), true);
  assert.match(googleEmbeddingEndpoint(cfg), /:embedContent$/);
});

test("googleEmbeddingBody includes output_dimensionality when positive", () => {
  const b = googleEmbeddingBody("text-embedding-004", "hi", 256);
  assert.equal((b as any).output_dimensionality, 256);
  assert.equal((googleEmbeddingBody("m", "hi") as any).output_dimensionality, undefined);
});

test("oversize detection + helpers", () => {
  assert.equal(looksLikeOversizeError(413, "payload too large"), true);
  assert.equal(isNonEmptyNumberArray([1, 2, 3]), true);
  assert.equal(isNonEmptyNumberArray([]), false);
  assert.equal(isSafeExtraHeader("X-Custom", "v"), true);
  assert.equal(isSafeExtraHeader("authorization", "v"), false);
  assert.equal(isLocalOrPrivateHttpEndpoint("http://127.0.0.1:1234/v1/embeddings"), true);
});
```
(If `looksLikeOversizeError`'s real signature differs, adjust the call to match the copied function — do not change the function.)

- [ ] **Step 3: Run tests**

Run: `cd packages/embedding && npm test`
Expected: providers tests + smoke pass.

- [ ] **Step 4: Commit**

```bash
git add packages/embedding/src/providers.ts packages/embedding/test/providers.test.ts
git commit -m "feat(embedding): move pure provider helpers into the shared package"
```

---

### Task 3: `fetchEmbedding` with injected deps

**Files:**
- Create: `packages/embedding/src/fetch-embedding.ts`, `packages/embedding/test/fetch-embedding.test.ts`
- Source: `apps/llm-wiki/src/lib/embedding.ts` `fetchEmbedding` (the function body, ~lines 108-230).

**Interfaces:**
- Consumes: `EmbeddingConfig`, `EmbeddingDeps`, `EmbeddingResult` (A1); the helpers from `providers.ts` (A2).
- Produces: `fetchEmbedding(text: string, cfg: EmbeddingConfig, deps: EmbeddingDeps, maxRetries?: number): Promise<EmbeddingResult>`.

- [ ] **Step 1: Write failing tests (stub fetch, no real network)**

`packages/embedding/test/fetch-embedding.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchEmbedding } from "../src/fetch-embedding.ts";
import type { EmbeddingDeps } from "../src/types.ts";

function depsReturning(seq: Array<{ ok: boolean; status?: number; json?: unknown; text?: string }>): EmbeddingDeps {
  let i = 0;
  return {
    fetch: async () => {
      const r = seq[Math.min(i++, seq.length - 1)];
      return {
        ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), statusText: "x",
        json: async () => r.json, text: async () => r.text ?? "",
      };
    },
  };
}

const cfg = { endpoint: "http://127.0.0.1:1234/v1/embeddings", model: "m" };

test("openai happy path returns the vector", async () => {
  const deps = depsReturning([{ ok: true, json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } }]);
  const r = await fetchEmbedding("hello", cfg, deps);
  assert.deepEqual(r.vector, [0.1, 0.2, 0.3]);
  assert.equal(r.error, undefined);
});

test("oversize -> auto-halve retry then succeed", async () => {
  const deps = depsReturning([
    { ok: false, status: 413, text: "payload too large" },
    { ok: true, json: { data: [{ embedding: [1, 2] }] } },
  ]);
  const r = await fetchEmbedding("a".repeat(2000), cfg, deps);
  assert.deepEqual(r.vector, [1, 2]);
});

test("missing embedding shape -> null vector with error", async () => {
  const deps = depsReturning([{ ok: true, json: { data: [{}] } }]);
  const r = await fetchEmbedding("x", cfg, deps);
  assert.equal(r.vector, null);
  assert.match(r.error!, /missing data\[0\]\.embedding/);
});

test("http auth error -> null with API error string", async () => {
  const deps = depsReturning([{ ok: false, status: 401, text: "unauthorized" }]);
  const r = await fetchEmbedding("x", cfg, deps);
  assert.equal(r.vector, null);
  assert.match(r.error!, /API 401/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/embedding && npm test`
Expected: FAIL — cannot find `../src/fetch-embedding.ts`.

- [ ] **Step 3: Implement by moving the wiki's `fetchEmbedding`**

Copy the wiki's `fetchEmbedding` body (`apps/llm-wiki/src/lib/embedding.ts`) into `fetch-embedding.ts`, applying EXACTLY these mechanical changes (logic and error STRINGS otherwise unchanged):
1. Signature: `export async function fetchEmbedding(text, cfg: EmbeddingConfig, deps: EmbeddingDeps, maxRetries = 3): Promise<EmbeddingResult>`.
2. Replace `const httpFetch = await getHttpFetch()` with `const httpFetch = deps.fetch`.
3. Replace `...(isLocalOrPrivateHttpEndpoint(endpoint) ? localLlmOriginHeader() : {})` with `...(deps.originHeader && isLocalOrPrivateHttpEndpoint(endpoint) ? deps.originHeader() : {})`.
4. Replace the network-error branch `if (isFetchNetworkError(err))` with `if (deps.isNetworkError?.(err))`.
5. Everywhere the wiki sets `lastEmbeddingError = X` and/or `console.warn(...)` and then `return null` / `return embedding`: instead RETURN the structured result. Concretely: success → `return { vector: embedding }`; every failure path → `return { vector: null, error: X }` using the SAME string `X` the wiki built. Remove all `console.warn` and all references to the module-global `lastEmbeddingError`.
6. Import the helpers from `./providers.ts` and the types from `./types.ts`. Remove all wiki-only imports (`getHttpFetch`, `localLlmOriginHeader`, `isFetchNetworkError`, `invoke`, store types).

Preserve the retry loop, the oversize auto-halve (64-char floor), and every error string verbatim.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/embedding && npm test`
Expected: all fetch-embedding tests pass. (If an assertion's expected error substring does not match the wiki's real string, fix the TEST to match the wiki's verbatim string — never change the string.)

- [ ] **Step 5: Add index + commit**

`packages/embedding/src/index.ts`:
```ts
export * from "./types.ts";
export * from "./providers.ts";
export { fetchEmbedding } from "./fetch-embedding.ts";
```
Run `npm run typecheck` in the package (expect clean), then:
```bash
git add packages/embedding/src/fetch-embedding.ts packages/embedding/src/index.ts packages/embedding/test/fetch-embedding.test.ts
git commit -m "feat(embedding): fetchEmbedding with injected fetch/origin/network deps"
```

---

### Task 4: Migrate the wiki to the shared package (parity gate)

**Files:**
- Modify: `apps/llm-wiki/src/lib/embedding.ts`
- Possibly modify: `apps/llm-wiki/package.json` (add `@steward/embedding` workspace dep if the build needs it explicitly).
- Gate: `apps/llm-wiki/src/lib/embedding.test.ts` (+ the rest of the wiki suite) must pass UNMODIFIED.

**Interfaces:**
- Consumes: `@steward/embedding` (`fetchEmbedding`, the provider helpers, types).
- Produces: an `embedding.ts` whose PUBLIC exports are unchanged (same names/signatures the wiki app and its tests import).

- [ ] **Step 1: Establish the parity baseline**

Read `apps/llm-wiki/package.json` for the test command (vitest). Run the embedding suite BEFORE changing anything to confirm the baseline is green:
Run: `cd apps/llm-wiki && npx vitest run src/lib/embedding.test.ts`
Expected: all pass (record the count). If it does not run/pass on a clean checkout, STOP and report (environment issue to resolve first).

- [ ] **Step 2: Rewrite `embedding.ts` to delegate the HTTP core**

In `apps/llm-wiki/src/lib/embedding.ts`:
1. Add `import { fetchEmbedding as coreFetchEmbedding, isLocalOrPrivateHttpEndpoint, looksLikeOversizeError, isNonEmptyNumberArray, isSafeExtraHeader, googleEmbeddingEndpoint, googleEmbeddingBody, volcengineEmbeddingEndpoint, isGoogleEmbeddingConfig, isDoubaoMultimodalEmbeddingConfig, doubaoMultimodalEmbeddingBody } from "@steward/embedding"` (import whatever names the file's own code AND its tests reference).
2. Delete the now-moved local definitions of those helpers from this file.
3. Re-export the helpers the tests import, so existing imports keep resolving: `export { looksLikeOversizeError, isNonEmptyNumberArray, isSafeExtraHeader, isLocalOrPrivateHttpEndpoint, isGoogleEmbeddingConfig, ... } ` — match EXACTLY the set that `embedding.test.ts` imports from this module (read the test's import list first).
4. Replace the local `fetchEmbedding(text, cfg, maxRetries = 3)` with a wrapper that KEEPS the same signature and behaviour:
```ts
export async function fetchEmbedding(text: string, cfg: EmbeddingConfig, maxRetries = 3): Promise<number[] | null> {
  const httpFetch = await getHttpFetch();
  const result = await coreFetchEmbedding(text, cfg, {
    fetch: httpFetch,
    originHeader: localLlmOriginHeader,
    isNetworkError: isFetchNetworkError,
  }, maxRetries);
  if (result.error) {
    lastEmbeddingError = result.error;
    console.warn(`[Embedding] ${result.error}`);
  } else {
    lastEmbeddingError = null;
  }
  return result.vector;
}
```
Keep `lastEmbeddingError`, `getLastEmbeddingError`, `localLlmOriginHeader` (still imported from `llm-providers`), the chunking/`chunkMarkdown` orchestration, `vectorUpsertChunks`/`vectorSearchChunks`, search grouping, and incremental optimize EXACTLY as they were. Do not touch `text-chunker.ts`.

- [ ] **Step 3: Run the wiki suite — parity gate**

Run: `cd apps/llm-wiki && npx vitest run src/lib/embedding.test.ts`
Expected: the SAME pass count as Step 1, all green, **without editing any test**. Then run the broader related suites that import embedding (at least: `npx vitest run src/lib`) and confirm green.
If any test fails: the adapter is not byte-identical — fix the adapter (e.g. an error string, the origin-header condition, the return-null timing) until green. NEVER edit a test to make it pass. If parity proves impossible, REVERT this task and report (safety valve: leave the wiki untouched; mail still uses the package).

- [ ] **Step 4: Typecheck both sides**

Run: `cd apps/llm-wiki && npm run -s typecheck` (or the wiki's typecheck script) and `cd packages/embedding && npm run typecheck`.
Expected: both clean (or no NEW errors in the wiki beyond pre-existing).

- [ ] **Step 5: Commit**

```bash
git add apps/llm-wiki/src/lib/embedding.ts apps/llm-wiki/package.json package-lock.json
git commit -m "refactor(llm-wiki): delegate embedding HTTP core to shared package (no behaviour change)"
```

---

## Self-review notes (addressed)

- **Spec coverage (Phase A):** shared pure core (A1-A3: types, providers, fetchEmbedding with injected deps + structured result), wiki migration with parity gate (A4). `text-chunker` deliberately NOT moved (documented deviation — mail does not chunk, so no de-duplication benefit, only migration risk).
- **Parity:** A4 runs the wiki's unmodified vitest suite as the gate, with an explicit revert/safety-valve if parity is unachievable.
- **Type consistency:** `EmbeddingConfig`/`EmbeddingDeps`/`EmbeddingResult` defined in A1, consumed unchanged in A2/A3; the wiki wrapper preserves its original `fetchEmbedding(text, cfg, maxRetries): Promise<number[] | null>` signature.
- **Phases B (mail-mirror sqlite-vec indexer) and C (mail-mcp hybrid search) get their own plans after Phase A executes.**
