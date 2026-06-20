# Mail → Wiki Promotion — Design

Sub-project 4 of the personal-agent platform. Automatically turn durable-personal-knowledge
emails into distilled wiki notes (summary + facts/commitments/people), added as wiki
**sources** with a `message://<Message-ID>` back-link — no raw-body duplication, idempotent
by Message-ID — so the agent's long-term memory grows from the mail corpus. Consumes the
mirror ([[mail-mirror-store]] / [[mail-advanced-search]]) read-only and the LLM
[[llm-gateway]] for classification + distillation. See [[personal-agent-platform-roadmap]].

## Goal

A new `apps/mail-promoter` that, over the ~68k-mail mirror, runs a **tiered cascade**:
cheap deterministic rules drop the obvious noise, a high-volume LLM (`local-*` via the
gateway) classifies survivors as "durable personal knowledge or not", and a low-volume
LLM (`sub-*` via the gateway) distills the promoted ones into a markdown note added to the
wiki. The same mechanism runs incrementally on new mail. A one-shot **evaluation** step
(run first, on a hand-labelled sample) picks the concrete models behind the gateway with
evidence.

## Non-Goals

- No raw-body copy into the wiki — the note is DERIVED (summary/extraction); the full mail
  stays in the mirror, reachable via `message://` → `read_message`.
- No direct entity/graph writes — promotion adds a wiki **source**; the wiki's existing
  ingest builds entities/pages from it (DRY).
- No new LLM client and no new JSON parser — use the gateway endpoint and the gateway's
  `extractJson`.
- The mirror DB is NOT written by the promoter (mail-mcp opens it read-only; the mirror is
  the sole writer). The promoter keeps its own state DB.
- Concrete model IDs are gateway CONFIGURATION (chosen by the evaluation), not hardcoded.

## Key Decisions

1. **Cascade: rules → classify(local) → distill(sub).** Cheap rules eliminate marketing /
   OTP / automated noise so the LLM only sees plausible candidates; the high-volume
   classify step runs on a local model (free, private, sees everything); only the few
   promoted mails are distilled on the subscription model (quality where it matters).
2. **Promotion target = wiki source.** A markdown file via the wiki `add_source` API; the
   wiki distils it into entities/pages. No direct graph writes.
3. **No duplication, `message://` back-link.** The note's frontmatter carries
   `message://<Message-ID>` plus from/date/subject/account/categories. Resolving the link =
   `read_message` (which already accepts a Message-ID).
4. **Idempotent by Message-ID.** A separate promoter SQLite DB (`promote_state`) records
   each decision; re-runs skip or update, never duplicate.
5. **Separate state DB.** The promoter owns `~/Library/Application Support/mail-promoter/…`;
   it never writes the mirror DB.
6. **LLM via the gateway, endpoint-agnostic.** `classify` → a `local-*` model;
   `distill` → `sub-*` (default) with `api-*` as a config fallback. Both behind one
   OpenAI-compatible endpoint (`MAIL_PROMOTER_LLM_ENDPOINT`, default the gateway). Free /
   subscription models do not honor structured-output → JSON parsed with the gateway's
   `extractJson`.
7. **Evaluation first, manual ground truth.** A one-shot harness scores the cascade on a
   hand-labelled sample (~50–100 mails: promote/skip + category) across candidate gateway
   models, reporting classification precision/recall and surfacing distilled notes for
   eyeballing — so the default models are chosen with evidence, not guessed.

## Architecture

```
mirror DB (read-only)                          LLM gateway (OpenAI-compatible)
   │ Store.openReadonly                            │  local-* (classify) / sub-* (distill)
   ▼                                               ▼
┌──────────────────── apps/mail-promoter ─────────────────────────┐
│ 1. prefilter (rules)   src/prefilter.ts   — deterministic drop   │
│ 2. classify (LLM)      src/classify.ts    — durable? + category  │
│ 3. distill  (LLM)      src/distill.ts     — markdown note (JSON) │
│ 4. note builder        src/note.ts        — frontmatter + body   │
│ 5. wiki promote        src/wiki.ts        — add_source(filename) │
│ 6. state/idempotency   src/state.ts       — promote_state (sqlite)│
│ 7. orchestrator + CLI  src/run.ts/cli.ts  — batch + incremental  │
│ eval harness           src/eval.ts        — labelled-sample score │
└──────────────────────────────────────────────────────────────────┘
                                   │ add_source
                                   ▼
                         LLM Wiki app HTTP API  → wiki sources/ → ingest → entities
```

### Components

- **`prefilter.ts`** — `shouldConsider(msg, role?): boolean`. Deterministic, using only
  what the mirror stores (the raw `List-Id`/`Precedence` headers are NOT mirrored): drop by
  **mailbox role** (junk/bulk/spam, resolved via `mailbox_roles`), **sender-address
  patterns** (`noreply@`, `no-reply@`, `notifications@`, `mailer@`, `newsletter@`, common
  bulk/marketing sender locals/domains), **subject patterns** (OTP / verification codes /
  unsubscribe-style notifications), and empty-bodied (`body_state = none`) messages. Pure,
  table-driven, unit-tested.
- **`classify.ts`** — `classify(msg, llm): Promise<{ promote: boolean; categories: string[] } | null>`.
  Prompts the model for a strict JSON verdict (durable personal knowledge? + tags from
  {commitment, document, personal-fact, decision, relationship}); parses with `extractJson`;
  `null` (no decision) when the LLM is unreachable. `llm` is an injected
  `(messages) => Promise<string>` over the gateway.
- **`distill.ts`** — `distill(msg, llm): Promise<DistilledNote | null>`. Asks for a JSON note
  (`summary`, `facts[]`, `commitments[]`, `people[]`, `orgs[]`); parses with `extractJson`.
- **`note.ts`** — `buildNote(msg, distilled): { filename: string; content: string }`. Markdown
  with YAML frontmatter: `message://<Message-ID>`, `from`, `date`, `subject`, `account`,
  `categories`; body = the distilled summary + bulleted facts/commitments/people. `filename`
  is a stable slug derived from the Message-ID (so re-promotion overwrites, not duplicates).
- **`wiki.ts`** — `promote(note, client): Promise<void>` calling the wiki `add_source`
  (`{ sources: [{ filename, content }], rescan }`). Reuses the wiki mcp-server's
  `LlmWikiApiClient.addSources` (DRY) — config: `LLM_WIKI_API_URL` (+ token), same as the
  mcp-server. The wiki app must be running.
- **`state.ts`** — a small SQLite `Store` (separate file): `promote_state(message_id PK,
  decision TEXT, categories TEXT, classify_model TEXT, distill_model TEXT, wiki_filename TEXT,
  source_hash TEXT, promoted_at INTEGER)`. `needsProcessing(messageId, sourceHash)`,
  `record(...)`. Re-promotes only when the mail's content hash changes.
- **`run.ts` / `cli.ts`** — orchestration: `backfill` (iterate the mirror's messages
  recent-first, run the cascade, skip-by-state) and `watch`/`reconcile`-style increment
  (process messages newer than the last cursor). CLI: `promote backfill | status | eval`.
- **`eval.ts`** — reads a labelled fixture (`message_id, label(promote|skip), categories`),
  runs `prefilter`+`classify` for a set of candidate gateway model names, prints a
  precision/recall/confusion table per model, and writes the distilled notes for the
  `promote`-labelled ones to a temp dir for manual quality inspection.

## Data Flow

1. Orchestrator pulls a batch of mirror messages (read-only) not yet in `promote_state`
   (or whose `source_hash` changed).
2. `prefilter` drops obvious noise (no LLM).
3. `classify` (gateway `local-*`) → promote? + categories; recorded in `promote_state`.
4. For promote=true: `distill` (gateway `sub-*`) → JSON note → `buildNote` → `wiki.promote`
   (`add_source`); `promote_state` records the wiki filename + models + hash.
5. The wiki ingests the new source into its entity/page graph.
6. Reading a promoted note's `message://` link resolves back to the full mail via
   `read_message`.

## Error Handling

- Gateway unreachable / LLM error: `classify`/`distill` return `null` → the mail is left
  unprocessed (no state row, retried next run) — never crashes the batch. Mirrors the Plan A
  injected best-effort pattern.
- Wiki API unreachable: `promote` throws; the orchestrator catches per-message, logs, and
  leaves that mail unprocessed for retry (no partial state recorded).
- Malformed LLM JSON: `extractJson` throws → treated as a classify/distill failure (retry).
- The promoter is read-only on the mirror; a mirror lock never blocks it (WAL readers).

## Testing

- `prefilter`: table of (sender/subject/mailbox-role/body) → drop/keep, unit-tested.
- `note.ts`: frontmatter has the `message://<Message-ID>` + metadata; filename is a stable
  Message-ID slug (idempotent overwrite); body renders summary + facts.
- `state.ts`: `needsProcessing` skips an already-promoted unchanged mail and re-flags one
  whose `source_hash` changed.
- `classify`/`distill`: injected stub `llm` returning fenced JSON → assert the parsed verdict
  / note (proves `extractJson` integration); a stub that throws → `null`.
- `wiki.ts`: injected fake client → `addSources` called with the right `{filename, content}`.
- `eval.ts`: a tiny labelled fixture + stub models → a correct precision/recall table.
- No network/LLM/wiki in unit tests — all injected. The wiki gate (90/90) and the gateway
  tests stay untouched.

## Constraints

- Read the mirror via `Store.openReadonly`; never write it.
- Reuse: the gateway endpoint (no new LLM client), the gateway's `extractJson`, the wiki
  mcp-server's `LlmWikiApiClient`, the mirror's `Store`/`MessageRow`. Do not reimplement.
- All LLM/wiki I/O is injected so unit tests never hit the network.
- Model IDs are gateway configuration (chosen by `eval`); nothing hardcodes a Claude/Ollama
  model in logic.
- Single spec + single implementation plan (the evaluation harness and the pipeline are
  parts of the same plan, not separate cycles).
