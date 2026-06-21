# Calendar MCP — Design

**Date:** 2026-06-21
**Status:** Approved (brainstorming complete)
**Sub-project:** B3 (action connectors) — first connector: Calendar.

## Goal

A Model Context Protocol server (`apps/calendar-mcp`) that lets the agent read,
search, and write the user's macOS Calendar. Reads come from Apple's local
Calendar store (fast, all fields, account-filterable); writes go through
AppleScript. Search is hybrid keyword + semantic, reusing the repo's existing
embedding/RRF machinery. No new TCC permission and no Swift toolchain.

## Background & decisive findings

Empirical benchmarks on the real machine (2026-06-21) drove the architecture:

- **AppleScript / JXA date-range queries are unusable for reads**: ~24–29s for
  *any* range (even 7 days), because `whose start date ≥ …` is an unindexed
  scan over every event in every calendar. Independent of result size.
- **EventKit (Swift) is ~650× faster** (0.043s) but requires a TCC Calendar
  grant tied to a code-signed `.app` bundle identity. In the dev environment
  (VS Code as the TCC "responsible process") the grant could not be obtained
  reliably; ad-hoc signatures lose the grant on every rebuild. Rejected to
  avoid a Swift toolchain + code-signing + fragile permission flow.
- **Apple's local store `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`
  is fully readable under the Full Disk Access the stack already has** (same
  model as the Mail mirror reading `.emlx`). A joined date-range query
  (CalendarItem → Calendar → Store → Location) returns in **~0.03s** with every
  field present. Verified: 545 events, 24 calendars, 10 stores.
- **AppleScript writes work and use the already-granted Automation permission.**
  Verified create + read-back + set-recurrence + delete on a real calendar in
  ~2.3s, with all settable fields (summary, start/end, all-day, location,
  description, url, recurrence `FREQ=…`).

Conclusion: **hybrid — read via SQLite, write via AppleScript.** This reuses the
exact pattern already in the repo (read the Apple local store directly +
AppleScript for actions) and needs no permission the stack does not already hold.

## Architecture

```
agent (host)
  │  MCP tools
  ▼
apps/calendar-mcp  (TypeScript MCP server)
  ├─ reads  ──▶ Calendar.sqlitedb (Apple, read-only)   [FDA]
  ├─ index  ──▶ calendar-index.sqlitedb (sidecar)       [owns: FTS5 + sqlite-vec vectors]
  │              embeds via gateway local-embed
  ├─ search ──▶ sidecar: FTS5 ⊕ vector → RRF
  └─ writes ──▶ osascript (AppleScript)                 [Automation]
```

Apple's store is **opened read-only and never written**. All durable index
state lives in a separate sidecar DB the connector owns — the same separation
mail-mirror and mail-promoter use.

### Data sources & key facts

- **Events**: `CalendarItem` where `entity_type = 2`. Dates are Core Data reals
  (seconds since 2001-01-01 UTC; Unix = value + 978307200). Fields: `summary`,
  `description`, `location_id`→`Location`, `start_date`/`start_tz`,
  `end_date`/`end_tz`, `all_day`, `calendar_id`, `status`, `availability`,
  `url`, `organizer_id`, `self_attendee_id`, `has_attendees`, `has_recurrences`,
  `conference_url`, `creation_date`, `last_modified`, `UUID`.
- **Calendars**: `Calendar` (`title`, `store_id`, `type`, `color`).
- **Accounts**: `Store` (`name`, `type`). Account filtering =
  CalendarItem → Calendar.store_id → Store. Verified counts per account.
- **Recurring events**: future instances are expanded in `OccurrenceCache`
  (`occurrence_start_date`, `occurrence_end_date`, `event_id`, `calendar_id`).
  A correct "events in range" read unions non-recurring `CalendarItem` rows with
  `OccurrenceCache` rows joined back to `CalendarItem` on `event_id` for detail.
- **Attendees**: `Participant` table (read side).

### Writes (AppleScript)

`create_event` / `update_event` / `delete_event` build pure AppleScript and run
it via the shared osascript runner. Settable: summary, start date, end date,
all-day, location, description, url, recurrence (RFC `FREQ=…`), alarms, status.
Target calendar referenced by name (AppleScript exposes the 17 user/synced
calendars; purely-local "On My Mac" calendars are not all visible to AppleScript
— acceptable since agent-created events should live in a synced calendar).

**Known limitation (documented):** AppleScript can list/add attendees but does
not send real invitations. Inviting participants is out of scope for v1.

## Reuse / extraction (no duplication)

The reusable pieces currently live inside mail-mcp/mail-mirror. They are
extracted into shared packages that **both** mail-* and calendar-mcp consume;
the mail apps are refactored to import them and keep their test suites green.

`packages/embedding` stays pure (no DB deps) — the wiki 90/90 gate must stay
green; nothing sqlite-related goes there.

### `packages/applescript`
- `runOsa(script, {timeoutMs, exec})` with one automatic retry on transient
  Apple Event errors (moved from `mail-mcp/src/osascript.ts`).
- `esc(s)` AppleScript string escaper (moved from `mail-mcp/src/applescript.ts`).
- Error mapping is **injectable**: `runOsa` takes an app-specific
  `mapError(stderr)` so Mail keeps its Mail.app messages and Calendar supplies
  its own. The Mail-specific `mapOsaError` stays in mail-mcp and is passed in.
- Dependencies: node only.

### `packages/search`
- `rrf(rankings, k?)` (moved verbatim from `mail-mcp/src/rrf.ts`).
- `embedText` / `embedTexts` null-on-failure wrappers over `@llm-wiki/embedding`
  (moved from `mail-mirror/src/embed-client.ts`).
- `VectorStore` helper: the generic sqlite-vec logic currently inlined in
  `mail-mirror/src/store.ts` — load the extension, `CREATE VIRTUAL TABLE … USING
  vec0(embedding float[dim])`, upsert by rowid, KNN (`embedding MATCH ? ORDER BY
  distance LIMIT ?`), and dimension-change reset — parameterized by table name
  and rowid mapping. mail-mirror's `Store` uses it internally for `vec_messages`.
- Dependencies: `better-sqlite3`, `sqlite-vec`, `@llm-wiki/embedding`.

### Refactor obligations
- mail-mcp: import `rrf`, `runOsa`, `esc` from the packages; pass its Mail error
  mapper. Behaviour and tests unchanged.
- mail-mirror: `Store` consumes the `VectorStore` helper and the embed wrappers;
  `embed-config.ts` default-gateway behaviour unchanged. Tests stay green.

## Sidecar index DB (`calendar-index.sqlitedb`)

Owned by calendar-mcp. Holds a minimal event mirror for search only:
- `events(uid PK, summary, description, location, start, end, all_day,
  calendar_title, account, last_modified, source_hash)`
- `events_fts` (FTS5 over summary/description/location)
- `vec_events` (sqlite-vec `vec0`) via the shared `VectorStore`
- `state(key, value)` for `vec_dim` etc. (mirrors mail-mirror)

### Sync (`calendar-mcp index` / `sync`)
1. Read events from the Apple store (range = configurable window, default a wide
   past/future span).
2. Upsert into the sidecar; `source_hash` over the embed-relevant fields decides
   what changed (`last_modified` + hash), idempotent like mail-promoter.
3. Embed `summary + description + location` for new/changed events via the
   gateway `local-embed` (default endpoint `http://127.0.0.1:4000/v1/embeddings`,
   `=off` to disable), batched.
4. Soft-handle deletions: events absent from the Apple store are removed from the
   sidecar.

Staleness is acceptable between syncs; `search_events` always resolves full,
live detail for returned hits from the Apple store (the sidecar is an index, not
the source of truth).

## MCP tools

- `list_calendars` → calendars with account, color, writable flag.
- `search_events(query?, start?, end?, calendar?, account?, limit?)` → hybrid:
  FTS5 ⊕ vector (gateway-embedded query) fused with `rrf`; falls back to FTS
  only when embeddings are unavailable (mirrors mail-mcp). Date/calendar/account
  act as filters on candidates. Returns events with full fields resolved live.
- `read_event(uid)` → all fields incl. attendees, recurrence, alarms.
- `create_event(calendar, summary, start, end, allDay?, location?, description?,
  url?, recurrence?, alarms?)` → AppleScript; returns new uid.
- `update_event(uid, …mutable fields)` → AppleScript.
- `delete_event(uid)` → AppleScript.

### Confirmation of destructive actions
Not implemented in the MCP. `create/update/delete` are gated by the host's
existing PreToolUse approval (already implemented), per the platform roadmap
(approval is an orchestrator concern, not a per-connector feature).

## File structure (`apps/calendar-mcp/src`)

- `apple-store.ts` — read-only open of Calendar.sqlitedb; Core Data date helpers;
  event/calendar/account queries incl. OccurrenceCache union.
- `index-db.ts` — sidecar schema (mirror + FTS5 + vec via shared `VectorStore`);
  open/migrate/upsert/delete/state.
- `sync.ts` — incremental index + embedding (gateway).
- `search.ts` — hybrid FTS + vector + `rrf`.
- `applescript.ts` — pure create/update/delete builders + Calendar error mapper;
  runs via `packages/applescript`.
- `args.ts` / `types.ts` — arg validation, ISO date parsing, pure builders.
- `cli.ts` — `index` / `sync` / `status`.
- `index.ts` — MCP server + tool registration.

## Error handling

- Read: if the Apple store is missing/unreadable → clear "grant Full Disk
  Access" message.
- Write: Calendar error mapper translates `-1728` (object not found → bad
  calendar/uid), `-1743` (Automation not granted → System Settings hint),
  timeouts.
- Embeddings unavailable → search degrades to FTS-only, never errors.

## Testing

- **Pure builders** (AppleScript create/update/delete, arg validation, date
  conversion) unit-tested with an injected `OsaExec` fake — the mail-mcp pattern.
- **Search** tested against an in-memory sidecar DB with seeded rows + a stub
  embedder; assert RRF fusion and FTS-only fallback.
- **Shared packages** get their own unit tests (rrf, esc, runOsa retry,
  VectorStore upsert/KNN).
- **Refactor safety**: mail-mcp and mail-mirror suites must stay green after the
  extraction.
- A `realtest.mts` (excluded from CI, like mail-mcp's) exercises the live Apple
  store read + a create/delete round-trip on a real calendar.

## Global constraints

- Apple's `Calendar.sqlitedb` is opened **read-only**, never written.
- `packages/embedding` stays pure (no better-sqlite3 / sqlite-vec); wiki 90/90
  gate stays green.
- Commit only on the feature branch; never main. Do not delete existing
  `realtest.mts` / `e2e-smoke.mts`.
- Embeddings route through the LLM gateway by default (`local-embed`), `=off`
  disables — consistent with the centralized wiring.
- No new TCC permission required: reads use existing FDA, writes use existing
  Automation grant.

## Out of scope (v1)

- Sending real calendar invitations / managing attendees.
- Reminders (entity types other than events).
- A background watcher (sync is on-demand / scheduled, like the mail reconcile).
- EventKit / Swift helper (benchmarked and rejected).
