# Mail Hybrid Search + Shared Embedding — Design Spec

**Status:** approved design (2026-06-18)
**Sub-project 2 of 3** in the "Apple Mail as a queryable personal corpus" initiative.
Builds on sub-project 1 (`apps/mail-mirror`, the local SQLite Mail DB).

## Context & goal

Sub-project 1 mirrors Apple Mail into a local SQLite DB (FTS5, attachments,
threads, dedup). It is currently inert — `apps/mail-mcp` still searches Apple
Mail live via AppleScript (slow, fragile, subject/sender-only). This sub-project
makes mail-mcp **consume the Mail DB**: hybrid **FTS (BM25) + semantic (vector)**
search fused with RRF, real filters, results grouped by thread; `read_message`
served from the DB with a scoped AppleScript fallback for not-yet-downloaded
bodies. AppleScript remains only for actions (send/reply) and that body fallback.

Semantic search needs embeddings. The embedding logic already exists in the wiki
(`apps/llm-wiki/src/lib/embedding.ts`) but is Tauri-coupled. Rather than duplicate
it, we **extract the pure core into a shared workspace package** consumed by both
the wiki and mail.

## Goal & boundaries

**In scope:**
- **Phase A — `packages/embedding`:** a pure, framework-agnostic embedding core
  (request building for OpenAI-compatible / Google / Volcengine providers,
  oversize auto-halve retry, response parse, error classification) plus the pure
  `text-chunker`. Consumed by both apps via dependency injection (`fetch`,
  optional origin header). **The wiki's `embedding.ts` is migrated to a thin
  adapter over this package with ZERO behavioural change** (see the parity
  constraint below).
- **Phase B — embedding indexer (`apps/mail-mirror`):** a vector index in the
  Mail DB (sqlite-vec), an embedding worker integrated with the daemon, and an
  `embed` CLI for recent-first backfill. Graceful degradation when the endpoint
  is unreachable.
- **Phase C — hybrid search (`apps/mail-mcp`):** rewrite `search_messages` and
  `read_message` to query the Mail DB (FTS + vector → RRF, real filters, thread
  grouping; scoped AppleScript body fallback). Send/reply unchanged.

**Out of scope:** wiki promotion / note generation (sub-project 3); changing the
wiki's chunking, storage, optimize, or settings behaviour (parity required); any
new embedding provider beyond what the wiki already supports.

## NON-NEGOTIABLE constraint: llm-wiki behaves exactly as today

Phase A is a **behaviour-preserving refactor** of the wiki. It MUST NOT change
any observable wiki behaviour. Enforced by:
1. **The wiki's entire existing test suite stays green, unmodified** — the 90
   `embedding.test.ts` cases and `embedding.real-llm.test.ts` are the regression
   gate. Tests may MOVE to `packages/embedding`, but the wiki's remaining adapter
   tests must pass unchanged in intent.
2. **Byte-identical error strings**: every `lastEmbeddingError` message the wiki
   surfaces to Settings → Embedding today must be reproduced verbatim by the
   adapter; the Tauri `localLlmOriginHeader()` origin header for local-LLM CORS
   is still injected.
3. **Identical I/O**: same HTTP request bodies/headers per provider, same retry
   behaviour, same returned vectors, same chunking, same `invoke` storage calls,
   same incremental-optimize accounting.

**Safety valve:** if exact parity cannot be preserved during implementation,
LEAVE `apps/llm-wiki` untouched and have only mail consume `packages/embedding`
(the wiki migration is deferred). The wiki must never regress.

## Phase A — `packages/embedding`

A pure ESM TypeScript workspace package. **No Tauri, no Node-only, no React
imports.** All environment specifics are injected.

**Surface:**
```ts
export interface EmbeddingConfig {
  endpoint: string;            // e.g. http://127.0.0.1:1234/v1/embeddings
  apiKey?: string;
  model: string;
  outputDimensionality?: number; // Gemini native only
  extraHeaders?: Record<string, string>;
}
export interface EmbeddingDeps {
  fetch: typeof fetch;                 // injected (Tauri plugin fetch | Node global fetch)
  originHeader?: () => Record<string, string>; // optional (wiki injects Tauri origin; mail omits)
  isNetworkError?: (e: unknown) => boolean;    // optional classifier
}
export interface EmbeddingResult { vector: number[] | null; error?: string }

export async function fetchEmbedding(text: string, cfg: EmbeddingConfig, deps: EmbeddingDeps, maxRetries?: number): Promise<EmbeddingResult>;

// pure provider helpers + chunker (moved from the wiki, unchanged logic)
export function chunkText(content: string, opts?: ChunkOptions): Chunk[];
```

Key change from the wiki original: NO module-global `lastEmbeddingError` and NO
`console.warn`. `fetchEmbedding` returns `{ vector, error }`; each consumer
surfaces the error its own way (wiki → `lastEmbeddingError` + console; mail →
logger). The exact error STRINGS are produced here so both consumers get the
same text.

**Provider helpers to move (pure):** `isGoogleEmbeddingConfig`,
`isDoubaoMultimodalEmbeddingConfig`, `googleEmbeddingEndpoint`,
`volcengineEmbeddingEndpoint`, `googleEmbeddingBody`,
`doubaoMultimodalEmbeddingBody`, `looksLikeOversizeError`,
`isLocalOrPrivateHttpEndpoint`, `isNonEmptyNumberArray`, `isSafeExtraHeader`,
plus `text-chunker`. `endpoint-normalizer` stays in the wiki unless embedding
needs it (it does not call it directly).

**Wiki adapter (`apps/llm-wiki/src/lib/embedding.ts`, slimmed):** imports the
package; injects `getHttpFetch` + `localLlmOriginHeader` + `isFetchNetworkError`;
maps `result.error` to `lastEmbeddingError` + the existing `console.warn`; keeps
chunking (now via the package), vector storage via `invoke`, and incremental
optimize. Behaviour identical (see parity constraint).

## Phase B — embedding indexer (`apps/mail-mirror`)

**Vector storage:** sqlite-vec (vec0 virtual table) loaded into better-sqlite3,
on-disk (low RAM — respects the <250MB budget). A **planning spike validates
sqlite-vec loads** in better-sqlite3 on this Mac; if it cannot load, fall back to
a `BLOB` embeddings table + brute-force cosine read from disk (documented
fallback, not in RAM).

Schema (added without touching Phase-1 tables):
```
vec_messages  -- sqlite-vec virtual table: rowid = messages.rowid, embedding float[D]
embed_state   -- per message: message_id PK, model TEXT, dim INTEGER, embedded_at INTEGER, source_hash TEXT
```
`source_hash` = hash of the embedded text (subject+body); lets the worker skip
unchanged messages and re-embed when a partial body fills.

**Config:** `EmbeddingConfig` for mail from env / a small config file
(`MAIL_EMBED_ENDPOINT`, `MAIL_EMBED_MODEL`, `MAIL_EMBED_API_KEY`,
`MAIL_EMBED_DIM`). Defaults documented to match the wiki's local endpoint.

**Indexer:**
- `embedMessage(store, cfg, deps, messageId)`: build text = `subject + "\n" +
  bodyText` (truncated to a max-chars knob), `fetchEmbedding`, upsert vector +
  `embed_state`. One vector per message (no chunking for now — emails are short;
  long ones are truncated).
- Integrated with the daemon: after ingest (`watch`/`backfill`), enqueue the
  message; a worker drains the queue calling the endpoint.
- `mail-mirror embed` CLI: backfill embeddings **recent-first** over messages
  lacking a current `embed_state` (or whose `source_hash` changed). Bounded,
  resumable, idempotent.
- **Graceful degradation:** endpoint unreachable → leave un-embedded, log once,
  continue; search degrades to FTS-only. Re-embed when a partial body is filled
  (`body_state` none/partial → full).

## Phase C — hybrid search (`apps/mail-mcp`)

mail-mcp imports, from `apps/mail-mirror` (cross-workspace, as the AppleScript
fallback already does): `Store` (opened read-only) and a single mail embedding
client `embedText(text): Promise<number[] | null>` that wraps
`packages/embedding`'s `fetchEmbedding` with mail's configured `EmbeddingConfig`
and the Node `fetch`. The indexer (Phase B) and the query-embed (Phase C) use the
SAME `embedText`, so configuration and provider handling live in one place.

**`search_messages` (rewritten over the Mail DB):**
- Filters become real DB predicates: `account`, `mailbox`, `sender`,
  `recipient`, `dateFrom`/`dateTo`, `unreadOnly`, `flaggedOnly`,
  `hasAttachments`, `limit`, `offset`.
- `query` (free text): run **FTS5 (BM25)** over subject+from+to+body AND, when
  embeddings are available, **vector KNN** (embed the query, sqlite-vec search);
  **fuse with Reciprocal Rank Fusion** (`score = Σ 1/(K + rank_i)`, K=60), a
  small pure function. No embeddings/endpoint → FTS-only.
- **Group by `thread_id`:** return one result per thread (best-scoring message)
  with thread metadata (subject, message count, last date); a flag can request
  per-message results.
- Returns the same `MessageSummary` shape (plus `threadId`, `score`) so the host
  UI is unaffected.

**`read_message` (rewritten over the Mail DB):**
- Read the row + attachments from the DB (fast). If `body_state != 'full'`, run
  the **scoped** AppleScript fallback: a new mail-mcp `readScript` variant that
  searches only the message's stored `account` + `mailbox` (fast, avoids the
  ~90s unindexed all-mailbox scan), via the existing `fillBody` path; persist the
  filled body. If Mail is not running, return metadata + a clear marker.

**Removed:** live AppleScript search from the default path (the Mail DB is
authoritative; FSEvents keeps it current). **Unchanged:** `send_email`, `reply`,
`save_attachment`, `list_mailboxes`.

**Empty/missing DB:** if the Mail DB has no messages, `search_messages` returns a
clear "mirror not populated yet — run `mail-mirror backfill`" message rather than
silently returning nothing.

## Data flow

```
mirror ingest (Phase 1) ──► embedding worker (Phase B) ──► Mail DB (FTS + vec_messages)
mail-mcp.search (Phase C): query ─► FTS(BM25) + vector(KNN) ─► RRF ─► group by thread
mail-mcp.read: Mail DB row (+ scoped AppleScript fallback for partial bodies)
packages/embedding (Phase A): text → vector, used by the worker AND the query embed
```

## Error handling

- Embedding endpoint down/unconfigured → FTS-only search; indexer skips and
  retries later; surfaced in `mail-mirror status` (embedded vs total).
- sqlite-vec extension fails to load → documented BLOB+brute-force fallback.
- Mail DB empty → actionable message from `search_messages`.
- Partial body on read → scoped fallback; Mail not running → metadata + marker.
- Wiki adapter: any embedding error surfaces identically to today.

## Testing

- **packages/embedding:** unit tests with a STUB injected `fetch` — request shape
  per provider, oversize auto-halve retry, parse of each provider's response,
  error classification, and the exact error strings. The wiki's relevant
  embedding tests move here. `chunkText` keeps its existing tests.
- **Wiki adapter:** its existing suite stays green unmodified (parity gate).
- **Phase B indexer:** stub embedder → vector + `embed_state` written;
  `source_hash` skip; re-embed on body fill; endpoint-down → message left
  un-embedded; in-memory DB (+ sqlite-vec if loadable, else BLOB fallback path).
- **Phase C search:** seed a Mail DB with messages + stub vectors → RRF fuses FTS
  and vector ranks; thread grouping; FTS-only fallback when no vectors; filters
  map to DB predicates. `read_message` from DB + scoped fallback via injectable
  runner. RRF is a pure unit test.

Test runner: `node --import tsx --test "test/**/*.test.ts"` (mail workspaces);
the wiki keeps its own (vitest) runner.

## Global constraints (apply to every task in the plan)

- **Reuse over reimplement:** the embedding core is shared (`packages/embedding`),
  not duplicated; mail-mcp imports `Store` + embedding from `apps/mail-mirror`;
  the scoped read reuses the existing `fillBody`/mail-mcp AppleScript.
- **llm-wiki parity is non-negotiable** (see the dedicated section): existing
  wiki tests green unmodified, byte-identical error strings, identical I/O; else
  leave the wiki untouched.
- `packages/embedding` is pure ESM TS — no Tauri / Node-only / React imports;
  all environment specifics injected.
- Vectors stored on disk (sqlite-vec, low RAM); one vector per message.
- ESM TypeScript; mail workspaces test via `node --import tsx --test`. No new
  runtime deps beyond `sqlite-vec` (mail side) — justify any other.
- SQLite WAL; the mirror/indexer is the only writer; mail-mcp reads read-only.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;
  avoid apostrophes in heredoc commit bodies.
