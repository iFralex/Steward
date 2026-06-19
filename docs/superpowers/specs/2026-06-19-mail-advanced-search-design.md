# Account-Aware Storage + Advanced Mail Search — Design

Sub-project 2.5 of "Apple Mail as a queryable personal corpus". Builds on the
mirror (sub-project 1, `mail-mirror`) and hybrid search (sub-project 2,
`mail-mcp`). It enriches the mirror with account identity, message flags, and
recipient display names, adds a trigram index for arbitrary substring matching
in every field, and exposes a richer, account-aware search surface plus a
thread-expansion tool.

## Goal

Let the agent answer queries the current software cannot, such as:

- "le mail di ifralex.business@gmail.com nella casella Bozze" (per-account,
  per-mailbox filtering by friendly email + localized mailbox).
- "le mail non lette / contrassegnate / con risposta / nello spam".
- "le persone che hanno nel nome cristiana" — substring match inside any
  field (sender/recipient name or address, subject, body), both lexical and
  semantic.
- "gli allegati PDF più grandi di 5 MB di questo mese, dal dominio @polimi.it".
- "espandi questa conversazione" (full thread).

…and keep all of it **dynamic**: adding a new account or mailbox, or reading /
flagging / moving a message, is reflected in the mirror automatically with no
manual step.

## Non-Goals

- No change to `packages/embedding` → the wiki parity gate (90/90) stays
  untouched.
- Embeddings remain over **subject + body only** (concepts). Names and
  addresses are matched lexically (trigram), never embedded.
- `mail-mcp` stays read-only on the DB; `mail-mirror` remains the only writer.
- Gmail/IMAP network access stays disabled — Apple Mail on-disk store only.

## Decomposition

Two plans, executed in order. Plan B depends on Plan A's data.

- **Plan A — Mirror enrichment** (`apps/mail-mirror`): produces the new data
  (accounts table, flags, recipient names, trigram index) and keeps it fresh
  incrementally.
- **Plan B — Advanced search surface** (`apps/mail-mcp`): consumes Plan A's
  data through new filters, field-scoped queries, and a thread tool.

## Key Decisions

1. **Account identity via AppleScript.** `id of account` returned by Mail's
   AppleScript is byte-identical to the on-disk `V10/<UUID>` directory name
   (verified across all 16 accounts), and `messages.account` already stores
   that UUID. So the friendly-name source is one AppleScript call —
   `{id, name, email addresses}` per account — not `Accounts4.sqlite` reverse
   engineering.
2. **Threading stays union-find on `references`** (cross-account, no AppleScript
   dependency) as primary. Apple's native `conversation-id` from the `.emlx`
   plist is stored as an auxiliary `apple_thrid` column to support
   `get_thread`, not as the primary thread key.
3. **Embeddings unchanged** (subject + body). Identity fields go through the
   trigram index. No re-embedding is triggered by this sub-project, because the
   embedding source text does not change.
4. **Trigram index is additive.** A new FTS5 `trigram` table sits next to the
   existing plain FTS5 (BM25, word ranking). The plain index keeps powering the
   `query` free-text relevance ranking; trigram powers substring / fuzzy
   field-scoped matching. Neither replaces the other.
5. **Mailbox roles are auto-discovered, never hardcoded.** The role of each
   mailbox (drafts / sent / trash / junk / inbox / archive / important /
   flagged) is derived from the IMAP SPECIAL-USE attributes Mail caches per
   account, then — for mailboxes without that attribute — an optional AI
   classification of the mailbox name (if an LLM endpoint is configured), then
   the localized role terms Mail itself exposes. No author-maintained list of
   localized mailbox names. Adding a new account (possibly with
   differently-named mailboxes, in any language) gets its roles discovered
   automatically — see A6.
6. **Dynamic by construction.** All enrichment runs in the existing
   `backfill` / `watch` / `reconcile` loop, not only at first import.

---

## Plan A — Mirror Enrichment

### A1. Account identity (`accounts` table)

- New `accountsScript()` (AppleScript) emitting one line per account:
  `id | name | comma-joined email addresses`.
- New table `accounts(uuid TEXT PRIMARY KEY, name TEXT, emails TEXT)`.
- `Store.upsertAccount(uuid, name, emails)` and `Store.accounts()` /
  `Store.accountByEmailOrName(q)`.
- Populated during `backfill` and refreshed during `watch`:
  - on every `watch` cycle (one cheap AppleScript call), and
  - immediately when `reconcile` ingests a path whose `account` UUID is not yet
    in `accounts` (covers a freshly added account between cycles).

### A2. Flags + plist metadata from the `.emlx` trailer

The `.emlx` layout is `byte-count line + RFC822 message + <plist> trailer`.
Today the trailer is sliced off and discarded. Parse it.

- Extend `emlx.ts` to parse the trailing plist and return, in addition to the
  RFC822 fields: `flags` (integer bitfield), `color` (integer), and Apple
  `conversation-id` (integer).
- Decode the bitfield into booleans. The Apple Mail `.emlx` flags bitfield (low
  bits) is: bit0 `read`, bit1 `deleted`, bit2 `answered`, bit4 `flagged`,
  bit6 `forwarded`, bit8 `redirected`, plus a `junk` bit. **The exact bit
  positions are validated during implementation** against messages whose state
  is known via AppleScript (e.g. a known-unread vs known-read message, a
  flagged message), and the decoder is covered by a unit test using captured
  real flag integers. `unread = NOT read`.
- New / populated columns on `messages`: `unread` and `flagged` (exist today,
  currently always 0 → now populated), plus new `answered INTEGER DEFAULT 0`,
  `junk INTEGER DEFAULT 0`, `flag_color INTEGER`, `apple_thrid INTEGER`.

### A3. Recipient / CC display names

- `to_addrs` / `cc_addrs` store addresses only today. Add `to_names` and
  `cc_names` columns (newline- or JSON-encoded, matching the existing
  convention for `to_addrs`).
- mailparser already exposes `.name` per address — populate at ingest.
- These feed the trigram index (A4) so recipient-name substring search works.

### A4. Trigram index

- New `messages_trig` FTS5 table using `tokenize = 'trigram'` over:
  `from_name, from_addr, to_names, to_addrs, cc, subject, body`.
- Kept in sync alongside the existing plain `messages_fts` on every
  `upsertMessage` (DELETE + INSERT by rowid, same pattern as `messages_fts`).
- Enables arbitrary substring (`MATCH 'ristian'`) and field-scoped
  (`from_name : cristiana`) matching in any field.

### A6. Mailbox role discovery (`mailbox_roles` table)

Roles are discovered, not hardcoded, so a newly added account — whatever its
mailboxes are named, in any language — is classified automatically.

- New table `mailbox_roles(account_uuid TEXT, mailbox_name TEXT, role TEXT,
  PRIMARY KEY (account_uuid, mailbox_name))`. `role` ∈ {inbox, drafts, sent,
  trash, junk, archive, important, flagged} or NULL when unknown.
- **Primary source — IMAP SPECIAL-USE bits.** Parse each account's
  `~/Library/Mail/V10/<UUID>/.mboxCache.plist`, walk `mboxes` recursively
  through `IMAPMailboxChildren`, and decode each mailbox's
  `IMAPMailboxAttributes` (the low `0x40` base bit is masked off). Validated on
  real data: `0x1000` drafts, `0x8000` sent, `0x10000` trash, `0x4000` junk,
  `0x400` archive/all, `0x20000` important, `0x2000` flagged; `INBOX` by name.
  The exact bit set is re-confirmed during implementation with a unit test over
  captured real attribute integers.
- **Fallback 1 — AI classification (if an LLM is configured).** For a mailbox
  with no SPECIAL-USE bit, optionally ask a configured LLM to map its name to a
  role keyword (or "none") for non-standard / oddly-named mailboxes. This is
  injected like the embed dependency (a `classifyRole?` function, gated by an
  env-configured chat endpoint — "se disponibile"); when absent it is skipped.
  Volume is tiny (tens of distinct mailbox names total, not per-message) and the
  result is cached in `mailbox_roles`, so at most a handful of calls ever run.
  An LLM error or low-confidence "none" falls through to Fallback 2.
- **Fallback 2 — Mail's own localized role terms.** When no LLM is configured
  (or it returned "none"), fetch the localized role *names* Mail itself reports
  for its app-level special mailboxes via AppleScript (`name of drafts mailbox`,
  `sent mailbox`, `trash mailbox`, `junk mailbox`), strip the unified-suffix
  (e.g. "(tutte)"/"(all)"), and match the base term against the account's
  mailbox names. These terms come from Mail in the current UI language — they
  are not authored here and adapt automatically to the user's language.
- **Literal names always work.** A mailbox whose role can't be determined is
  still fully searchable by its verbatim name (B1).
- Populated during `backfill`, refreshed each `watch` cycle and whenever a new
  account UUID appears (alongside A1's account refresh).

### A5. Migration + incremental freshness

- A `mail-mirror migrate` command (idempotent): runs `ALTER TABLE` for the new
  columns, creates `accounts` and `messages_trig`, then re-parses existing
  `.emlx` files to backfill `flags`, recipient names, and `apple_thrid`, and
  rebuilds `messages_trig`. No embeddings are touched → minutes, not hours.
- **mtime-based change detection** added to `reconcile`/`sync`: today the sync
  diffs only the path set (added / removed). Add detection of *modified*
  `.emlx` (mtime newer than the stored `updated_at` for that path) and
  re-ingest them, so flag/state changes (read, flagged, moved) propagate. The
  message-id dedup and multi-path model are unchanged.

---

## Plan B — Advanced Search Surface (`mail-mcp`)

### B1. Account + mailbox filters

- `account` filter accepts a friendly **email or account name** (resolved via
  `accounts`) in addition to a raw UUID.
- `mailbox` filter accepts a **role keyword** (`drafts`, `sent`, `trash`,
  `junk`, `inbox`, `archive`, `important`, `flagged`) resolved through the
  auto-discovered `mailbox_roles` table (A6) — so `mailbox: "drafts"` matches
  Bozze, Drafts, or whatever that account's drafts mailbox is named, in any
  language, with no hardcoded list. A literal mailbox name still matches
  verbatim. A role keyword can resolve to different mailbox names per account
  and matches any of them.
- **match-any-mailbox**: optionally resolve the mailbox/account filter through
  `message_paths` so a message that lives in several mailboxes (Gmail
  All-Mail + label) is found by any of them, not just its primary mailbox.

### B2. Flag + rich filters

- Real `unreadOnly` / `flaggedOnly` (now populated), plus `answeredOnly`,
  `junkOnly`.
- `cc` (substring over `cc` addrs/names), `senderDomain` (suffix match on
  `from_addr`), `attachmentType` (mime/extension via `attachments`),
  `attachmentName` (substring on `attachments.filename`),
  `minSize` / `maxSize` (bytes), `sort` (`date` | `size`, `asc` | `desc`).
- All combined with AND via the existing `buildFilterSql` extension in
  `filters.ts`; `attachmentType`/`attachmentName` join the `attachments` table.

### B3. Field-scoped / substring query

- New optional params hitting `messages_trig`: `fromName`, `fromAddr`,
  `toName`, `subjectContains`, `bodyContains` — arbitrary substring, fuzzy,
  field-scoped.
- Free-text `query` keeps its hybrid BM25 (plain FTS) + semantic (vector RRF)
  ranking. Trigram params are filters layered on top (AND), not a replacement
  for ranking.

### B4. `get_thread` tool

- New MCP tool `get_thread` taking a `thread_id` (or a `messageId`/`id` from
  which the thread is resolved) and returning every message in the thread,
  ordered by date, with summaries (subject, from, date, mailbox, flags). Uses
  the union-find `thread_id`; `apple_thrid` is a secondary resolution path.

### B5. Tool schema + descriptions

- Update `search_messages` inputSchema with the new params and remove the
  "(not yet populated by the mirror)" caveats from `unreadOnly`/`flaggedOnly`.
- Document `account` accepting email/name and `mailbox` accepting canonical
  aliases.

---

## Data Flow

```
.emlx file ──parse(emlx.ts)──▶ {rfc822 fields, flags, color, apple_thrid, to_names, cc_names}
                                      │
            sync.ts upsertMessage ────┼──▶ messages (+flags/names/apple_thrid)
                                      ├──▶ messages_fts   (BM25 word ranking)
                                      ├──▶ messages_trig  (substring/fuzzy, all fields)
                                      └──▶ message_paths  (per-mailbox membership)
AppleScript accountsScript ──────────────▶ accounts (uuid→email/name), refreshed in watch
.mboxCache.plist + AppleScript fallback ─▶ mailbox_roles (uuid,mailbox→role), refreshed in watch

mail-mcp search ── buildFilterSql(accounts join, mailbox_roles resolution, flags, rich filters)
               ── + messages_trig field-scoped substring
               ── + hybrid query (plain FTS BM25 ⊕ vector KNN via RRF)
               ── group by thread_id
get_thread     ── thread_id (or apple_thrid) → all messages ordered by date
```

## Error Handling

- AppleScript for `accounts` may fail (Mail not running / no automation
  permission): `accounts` simply stays stale; `account` filter falls back to
  matching the raw UUID. Never blocks ingest or search.
- The plist trailer may be missing/garbled on a malformed `.emlx`: flags decode
  to all-false, parsing of the RFC822 body is unaffected.
- `messages_trig` is rebuilt from `messages`, so a corrupt trigram index is
  recoverable by `migrate` without data loss.
- A missing / unparseable `.mboxCache.plist`, or a provider that advertises no
  SPECIAL-USE and is resolved by neither the optional AI step nor a localized
  term, leaves `role` NULL for that mailbox: a role-keyword filter simply won't
  match it, but the mailbox stays searchable by its literal name. Role discovery
  never blocks ingest.
- The AI classifier is optional and best-effort: no configured endpoint, a
  network error, or a "none" answer all fall through to the localized-term
  match. It is never on the message ingest hot path (per distinct mailbox name,
  cached).

## Testing

- `node --test` per unit, matching existing mail-mirror / mail-mcp suites.
- A4/B3: trigram substring + field-scoped matching against seeded rows.
- A2: bitfield decoder over captured real flag integers (read/flagged/answered
  /junk permutations).
- A6: SPECIAL-USE attribute decoder over captured real `IMAPMailboxAttributes`
  integers (drafts/sent/trash/junk/archive/important/flagged); the optional
  AI-classifier step with an injected stub (resolves a non-standard name, falls
  through on "none"/error); and the localized-term fallback for an
  attribute-less, LLM-less account.
- B1: role-keyword → mailbox resolution via `mailbox_roles`, and email→UUID
  account resolution; literal mailbox names still match verbatim.
- B2: each rich filter in isolation and combined.
- B4: `get_thread` ordering and completeness.
- The wiki embedding gate (90/90) must remain green and unmodified.

## Sequencing

Plan A first (data), then Plan B (surface). Each gets its own implementation
plan and is executed via subagent-driven development on the existing
`feat/mcp-headless-claude-code` branch.
