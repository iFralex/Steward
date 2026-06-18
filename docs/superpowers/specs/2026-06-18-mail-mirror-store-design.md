# Mail Mirror & Store — Design Spec

**Status:** approved design (2026-06-18)
**Sub-project 1 of 3** in the "Apple Mail as a queryable personal corpus" initiative.

## Context & motivation

Live search of Apple Mail via AppleScript is slow and fragile: the RFC
`whose message id is` lookup is unindexed (~20-50s), `whose` queries stall
whenever Mail is syncing, and keyword/subject matching cannot bridge the
semantic gap (a query "train discounts Rome-Milan" never matches a promo
titled "-20% on your trips" from CartaFreccia). Per-provider IMAP/OAuth is
also not universal: Exchange tenants (e.g. Polimi) can disable IMAP or require
admin-approved OAuth.

The chosen architecture sidesteps all of this: **Apple Mail is already
authenticated and synced for every account**, so we mirror its content into a
local, queryable store and run all retrieval there — fast, semantic-capable,
offline, immune to Mail's state and to provider auth policy.

This spec covers **sub-project 1: the mirror and the store**. It is the
foundation the other two build on.

### The three sub-projects (decomposition)

1. **Mail mirror & store (this spec):** parse Apple Mail's on-disk `.emlx`
   store + AppleScript fallback into a local SQLite DB (messages + FTS5) and a
   content-addressed attachment blobstore, kept live via FSEvents + nightly
   reconcile. Dedup by Message-ID. Thread reconstruction.
2. **mail-mcp search over the store (later):** rewire `search_messages` /
   `read_message` to query the Mail DB (FTS + semantic embeddings, reusing
   LLM Wiki's embedding/RRF stack), grouped by thread. AppleScript retained
   only for actions (send/reply).
3. **Wiki promotion (later):** classify + score (wiki-worthy) + summarise a
   thread into a distilled note, dedup/merge resends, language policy, cost
   controls; emit via LLM Wiki `add_source` with links (Message-ID,
   `message://`, attachment sha256). Reuses the wiki's existing
   ingest/embed/dedup/graph pipeline.

## Goal & boundaries (this sub-project)

**Goal:** a populated, incrementally-maintained SQLite Mail DB + attachment
blobstore that is the single source of truth for raw mail content across all
accounts, with full-text (FTS5) search and reconstructed threads.

**In scope:** `.emlx` parser, AppleScript on-demand fallback, SQLite schema +
FTS5, content-addressed attachment store, dedup by Message-ID, thread
reconstruction, backfill (recent-first + lazy older), FSEvents watcher, nightly
reconcile, a CLI, and a LaunchAgent for persistent operation.

**Out of scope (later sub-projects):** semantic embeddings & vector search
(#2), the mail-mcp `search`/`read` rewrite (#2), classification / summarisation
/ wiki promotion (#3), sending/replying.

## Locked decisions

- **Extraction = hybrid.** Primary: read `.emlx` files from
  `~/Library/Mail/V*` and watch with FSEvents. Fallback: AppleScript
  on-demand for content not yet on disk (e.g. undownloaded Exchange messages),
  and a degraded AppleScript-only mode if Full Disk Access is unavailable.
- **Coverage = all accounts, recent-first.** Index the last ~24 months of all
  accounts first, then lazy-backfill older history in the background.
- **Local-first.** No cloud. Encryption at rest relies on FileVault; SQLCipher
  is a possible future addition (YAGNI now).
- **Dedup key = RFC Message-ID** (normalised, angle brackets stripped). Gmail
  "All Mail"/label duplicates collapse via upsert. Resends (distinct
  Message-IDs) are kept as separate rows here; near-duplicate merging is a #3
  concern.

## Architecture

A new TypeScript workspace **`apps/mail-mirror`** (consistent with
`apps/host`, `apps/mail-mcp`).

- **Library:** `.emlx` parser, SQLite store, sync engine, thread builder.
- **CLI** (`mail-mirror <cmd>`): `backfill`, `watch`, `reconcile`, `status`.
- **Persistence:** runs as a macOS **LaunchAgent** in `watch` mode (auto-start
  at login).
- **Reuse:** the AppleScript fallback reuses `apps/mail-mcp/src/applescript.ts`
  and `osascript.ts` (shared via a workspace import; no reimplementation).

The mirror **writes** the DB; mail-mcp (sub-project 2) only **reads** it.
SQLite runs in **WAL** mode so concurrent reads are safe during writes.

**Store location:** a dedicated app-data directory,
`~/Library/Application Support/mail-mirror/` (override via
`MAIL_MIRROR_DIR`), containing `mail.db` (SQLite) and `blobs/` (attachments).

## Data model (SQLite)

WAL mode. FTS5 required (assert at startup).

```
messages
  message_id   TEXT PRIMARY KEY   -- RFC Message-ID, normalised (no <>); if absent, sha256(headers+date)
  account      TEXT NOT NULL      -- Mail account name
  mailbox      TEXT               -- mailbox/folder name as on disk
  from_name    TEXT
  from_addr    TEXT
  to_addrs     TEXT               -- JSON array
  cc_addrs     TEXT               -- JSON array
  subject      TEXT
  date         INTEGER            -- epoch seconds (Date header; fallback file mtime)
  snippet      TEXT               -- first ~200 chars of body_text
  body_text    TEXT               -- plain-text body (best available)
  body_state   TEXT NOT NULL      -- 'full' | 'partial' | 'none'
  source       TEXT NOT NULL      -- 'emlx' | 'applescript'
  emlx_path    TEXT               -- absolute path when source='emlx'
  in_reply_to  TEXT               -- Message-ID this replies to (normalised)
  reference_ids TEXT              -- JSON array of Message-IDs (thread chain); NB: avoids SQLite keyword `references`
  gm_thrid     TEXT               -- X-GM-THRID hint when present (nullable)
  thread_id    INTEGER            -- surrogate, FK threads.id (see Threading)
  flagged      INTEGER DEFAULT 0
  unread       INTEGER DEFAULT 0
  size         INTEGER
  deleted      INTEGER DEFAULT 0  -- soft delete
  ingested_at  INTEGER
  updated_at   INTEGER

messages_fts  (FTS5, external-content over messages)
  -- indexed columns: subject, from_addr, from_name, to_addrs, body_text
  -- content_rowid maps to messages

attachments
  id           INTEGER PRIMARY KEY
  message_id   TEXT NOT NULL      -- FK messages.message_id
  filename     TEXT
  mime         TEXT
  size         INTEGER
  sha256       TEXT NOT NULL      -- content address
  blob_path    TEXT               -- blobs/<sha256> (relative)
  downloaded   INTEGER DEFAULT 0  -- 0 when known from headers but bytes not yet on disk

threads
  id           INTEGER PRIMARY KEY  -- surrogate thread_id
  subject      TEXT                 -- canonical (normalised) subject
  participants TEXT                 -- JSON array of addresses
  first_date   INTEGER
  last_date    INTEGER
  msg_count    INTEGER

accounts
  name         TEXT PRIMARY KEY
  emails       TEXT                 -- JSON array

sync_state
  key          TEXT PRIMARY KEY     -- e.g. 'backfill.recent.done', 'backfill.older.cursor'
  value        TEXT
```

Indexes: `messages(thread_id)`, `messages(account, date)`, `messages(date)`,
`attachments(message_id)`, `attachments(sha256)`.

An `embeddings` table is intentionally **not** created here; sub-project 2 adds
it without touching this schema.

**Attachment blobstore:** files stored content-addressed at
`blobs/<sha256>`; identical attachments are stored once. SQLite holds only
metadata + the hash/path (no BLOB columns).

## `.emlx` parsing

An `.emlx` file is: a first line with a byte count, then the raw RFC822
message, then an XML plist trailer (Apple flags). Parsing steps:

1. Strip the leading byte-count line and the trailing plist.
2. Parse the RFC822/MIME body with `mailparser` → headers, text body, HTML
   (convert to text if no text part), attachments.
3. Extract threading headers: `Message-ID`, `In-Reply-To`, `References`, and
   `X-GM-THRID` if present.
4. Write attachments to the blobstore (sha256), record metadata.
5. `body_state = 'full'` when a body part is present; `'partial'`/`'none'` for
   `.partial.emlx` / header-only stubs (Exchange not yet downloaded).

The parser is tolerant of format drift: on parse failure for a file, log and
fall back to AppleScript for that message rather than aborting the run.

## Threading

Goal: group messages into conversations so #2 can return threads and #3 can
promote one note per conversation.

- Capture `In-Reply-To`, `References`, and the `X-GM-THRID` hint.
- Maintain a **surrogate `thread_id`** via **union-find** over the Message-ID
  graph: any two messages sharing a reference (`References`/`In-Reply-To`) join
  the same set. Computed **incrementally** as messages arrive; a late
  "bridging" message merges two previously-separate sets (union), with no
  change to individual messages' identity.
- **Fallback** when threading headers are missing: `In-Reply-To` →
  normalised subject (strip `Re:/Fwd:/R:/AW:`/`I:` prefixes) **plus** participant
  overlap within a bounded time window. Subject-only matching alone is too
  noisy and is never used without participant + time constraints.
- The `threads` table caches per-thread metadata (canonical subject,
  participants, first/last date, message count), refreshed on upsert.

## Sync flow

1. **Backfill (recent-first):** enumerate `~/Library/Mail/V*/**/Messages/*.emlx`,
   ordered by file mtime descending; ingest the last ~24 months first, then
   continue with older files at low priority. Progress tracked in `sync_state`.
2. **Watch (FSEvents):** watch `~/Library/Mail` recursively (via `chokidar`,
   which uses FSEvents on macOS). On create/modify → parse + upsert; on
   unlink → soft-delete (`deleted=1`). Near-real-time.
3. **Reconcile (nightly):** full tree walk, diff against the DB, catch missed
   creates, deletes, and moves; verify soft-deletes.
4. **AppleScript fallback (on-demand):** exposed as a library call the reader
   (sub-project 2) invokes when it needs content for a row whose
   `body_state != 'full'` — fetches the body via AppleScript (reusing mail-mcp)
   and updates the row to `source='applescript'`, `body_state='full'`.

## Edge cases & error handling

- **Full Disk Access not granted:** detect the `EPERM`/`Operation not
  permitted` on `~/Library/Mail`; print a clear one-time setup instruction
  (System Settings → Privacy & Security → Full Disk Access); operate in
  degraded **AppleScript-only** mode until granted.
- **Mail version dir:** discover dynamically by globbing `~/Library/Mail/V*`
  (do not hardcode `V10`).
- **Undownloaded bodies (Exchange):** `body_state` reflects availability; the
  on-demand AppleScript fallback fills them lazily; the nightly reconcile can
  re-check `.partial.emlx` files that later completed.
- **Gmail "All Mail" + labels:** the same message appears under multiple paths;
  dedup by Message-ID via upsert (last write wins for mutable fields like
  flags; `mailbox` keeps the most specific non-All-Mail folder when known).
- **Resends:** distinct Message-IDs → separate rows here (merge is #3).
- **Deletions / moves:** FSEvents `unlink` → soft-delete; a move surfaces as
  unlink+create and re-associates by Message-ID. Reconcile is the safety net.
- **Concurrency:** WAL; the mirror is the only writer; readers (mail-mcp) use
  read-only connections.
- **Malformed `.emlx`:** skip-and-log + AppleScript fallback for that message;
  never abort the batch.

## Privacy

Local-only store; no network egress. Encryption at rest delegated to FileVault.
The store directory is created with user-only permissions (`0700`).

## Testing strategy

- **Unit:**
  - `.emlx` parser against committed fixture files (real exported `.emlx`
    samples covering: plain text, multipart+attachments, HTML-only, a
    `.partial.emlx` stub, and one with `References`/`In-Reply-To`) → asserts
    extracted fields, attachments, threading headers, `body_state`.
  - Upsert/dedup by Message-ID (duplicate path → single row; flag updates).
  - Thread builder: union-find over a synthetic Message-ID graph, including a
    late bridging message merging two sets; subject+participant fallback.
  - Blobstore: identical bytes → one file; sha256 addressing.
  - FTS query builder and snippet generation.
  - sync_state cursors.
- **Integration:** a **fake Mail store directory** in a tempdir (no Full Disk
  Access needed, CI-safe). Run `backfill` → assert DB rows/threads/attachments;
  add/modify/remove files to simulate FSEvents → assert incremental upserts and
  soft-deletes; run `reconcile` → assert drift correction.
- **AppleScript fallback:** tested via mail-mcp's injectable `OsaExec` runner
  (no real Mail needed).

Test runner: `node --import tsx --test "test/**/*.test.ts"` (same as the other
workspaces).

## Deliverable

`apps/mail-mirror`: a populated, incrementally-maintained SQLite Mail DB +
content-addressed attachment store, covering all accounts (recent-first),
threads reconstructed, kept live via FSEvents + nightly reconcile, with an
AppleScript fallback for not-yet-downloaded content; CLI (`backfill`, `watch`,
`reconcile`, `status`) and a LaunchAgent for persistent operation.

## Spike validation (2026-06-18)

The risky assumptions were prototyped before planning; all hold:

- **Stack on Node 24:** `better-sqlite3` compiles natively, FTS5 + WAL work;
  `mailparser` decodes encoded subjects, bodies, attachments, and threading
  headers; `chokidar` FSEvents `add` events fire. 8/8 spike checks passed.
- **Real store layout confirmed:** `~/Library/Mail/V10/<account-UUID>/<Mailbox>.mbox/<UUID>/Data/Messages/N.emlx`.
  Discover the version dir via glob `V*`.
- **`.emlx` format confirmed:** first line = byte count (may have trailing
  spaces), then the RFC822 message, then a plist trailer. **Parse by BYTES**
  (`buffer.subarray(nl+1, nl+1+count)`), not by characters — the count is
  UTF-8 byte length. A real full message parsed cleanly with a 3-deep
  `References` chain.
- **Full Disk Access is grantable and works** (granted to VS Code for the
  spike; production grant goes to the LaunchAgent daemon).
- **Coverage reality (important):** this Mac has **~36.6k full `.emlx`** and
  **~32.2k `.partial.emlx`** — roughly **47% of messages are header-only stubs**
  (body not downloaded). The AppleScript fallback / "request download" path is
  therefore **core, not an edge case**: backfill must record `body_state` per
  message and the reader must be able to fill partials on demand. Consider an
  optional bulk pre-download (Mail account setting "Download all messages") to
  raise local coverage.

## Global constraints (apply to every task in the plan)

- **Reuse over reimplement** (very important): the AppleScript fallback reuses
  `apps/mail-mcp/src/applescript.ts` + `osascript.ts`; do not duplicate them.
- **Stack:** Node + TypeScript; `better-sqlite3` (sync, FTS5); `mailparser`
  (MIME); `chokidar` (FSEvents-backed watching). npm workspace under `apps/`.
- **Tests:** `node --import tsx --test "test/**/*.test.ts"`; pure units where
  possible; integration via a fake store dir (no Full Disk Access in CI).
- **Isolation/clarity:** small, single-responsibility modules (parser, store,
  sync engine, thread builder, CLI) with clear interfaces.
- **Commit messages:** end with the Co-Authored-By trailer; avoid apostrophes
  in heredoc commit bodies.
```
