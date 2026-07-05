# Contacts MCP — Design

**Date:** 2026-06-21
**Status:** Approved (brainstorming complete)
**Sub-project:** B3 second connector: Contacts (after Calendar).

## Goal

An MCP server (`apps/contacts-mcp`) that lets the agent search, read, resolve, and
write the user's macOS Contacts. Reads come from Apple's local AddressBook stores
(read-only, Full Disk Access); writes go through AppleScript. Search is hybrid
keyword + semantic over a connector-owned sidecar index, reusing the shared
`@steward/search` and `@steward/applescript` packages. A `resolve_recipient`
tool turns a free-text descriptor ("the accountant", "Cristian from work") into
ranked candidate contacts with email — the roadmap's near-essential recipient
resolution primitive.

## Background & key facts (verified 2026-06-21)

- Contacts live in **multiple per-source SQLite stores**:
  `~/Library/Application Support/AddressBook/Sources/<UUID>/AddressBook-v22.abcddb`
  (the top-level `AddressBook-v22.abcddb` is empty). Several sources hold people
  (iCloud / Google / on-my-Mac); 182 contacts total on the dev machine. This
  mirrors the multi-account model of the Mail mirror and the calendar Stores.
- Schema (Core Data "Z" tables):
  - `ZABCDRECORD`: `Z_PK`, `ZUNIQUEID`, `ZFIRSTNAME`, `ZLASTNAME`, `ZNICKNAME`,
    `ZORGANIZATION`, `ZNOTE`.
  - `ZABCDEMAILADDRESS`: `ZOWNER` (→ record Z_PK), `ZADDRESS`,
    `ZADDRESSNORMALIZED`, `ZLABEL`.
  - `ZABCDPHONENUMBER`: `ZOWNER`, `ZFULLNUMBER`, `ZLABEL`.
- The stores are opened **read-only** (FDA, the same grant the Mail mirror and
  Calendar reader already use). Writes go through `osascript`/Contacts.app
  (Automation grant — verified working: `count of people` = 182).

This is the same hybrid pattern as `apps/calendar-mcp` (read the Apple local
store directly; AppleScript for actions), so it reuses that architecture and the
packages already extracted for it. There is **no extraction phase** — the shared
packages exist.

## Architecture

```
agent (host)
  │  MCP tools
  ▼
apps/contacts-mcp  (TypeScript MCP server)
  ├─ reads  ──▶ Sources/*/AddressBook-v22.abcddb (read-only, aggregated + deduped)   [FDA]
  ├─ index  ──▶ contacts-index.sqlitedb (sidecar: contacts mirror + FTS5 + sqlite-vec)
  │              embeds name+org+nickname+note via gateway local-embed
  ├─ search ──▶ sidecar: FTS5 ⊕ vector → RRF (filters pre-limit)
  ├─ resolve ─▶ hybridSearch → ranked candidates with email
  └─ writes ──▶ osascript (AppleScript create/update)                                [Automation]
```

### Multi-source aggregation & dedup

The reader scans every `Sources/*/AddressBook-v22.abcddb`, reads people + their
emails/phones, and aggregates. Dedup key:
- primary normalized email (`ZADDRESSNORMALIZED`, lowercased) when the contact has
  one; otherwise
- `(<source-uuid>, ZUNIQUEID)`.

When two source rows collapse to the same key, fields are merged (union of
emails/phones; first non-empty name/org/note wins). A stable `uid` is derived from
the dedup key (sha1) so the sidecar and AppleScript lookups agree.

### Contact shape

```ts
interface Contact {
  uid: string;            // stable dedup-key hash
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  nickname: string | null;
  note: string | null;
  emails: { address: string; label: string | null }[];
  phones: { number: string; label: string | null }[];
  sources: string[];      // source UUIDs the contact was found in
}
```

`displayName` = first+last, falling back to organization, then the first email.

### Sidecar index DB (`contacts-index.sqlitedb`)

Connector-owned; for search only. Mirror table `contacts(rowid, uid PK,
display_name, organization, nickname, note, primary_email, emails_json,
phones_json, source_hash)`, a **standalone** FTS5 `contacts_fts(display_name,
organization, nickname, note)`, `vec_contacts` via the shared `VectorStore`,
`embed_state`, and `state`. (Same shape and the standalone-FTS sync rule used by
calendar-mcp.)

### Sync

`contacts-mcp index` / `sync`: read all contacts from the AddressBook stores,
upsert into the sidecar (idempotent by sha1 `sourceHash` over the embed-relevant
fields), `deleteMissing` for vanished uids, and batch-embed new/changed contacts'
`displayName + organization + nickname + note` via the gateway `local-embed`
(default endpoint `http://127.0.0.1:4000/v1/embeddings`, `MAIL_EMBED_ENDPOINT=off`
disables).

### Search & resolve

`hybridSearch` fuses FTS (keyword) and vector (semantic) rankings with RRF,
**applying any filters before the limit** (the candidate-pool pattern adopted in
calendar-mcp's fix). `resolve_recipient(description)` runs `hybridSearch`, then
returns the top-N candidates that have at least one email, each with
`{ uid, displayName, organization, email, score }`. It does **not** auto-pick a
single recipient — it returns ranked candidates for the agent/user to confirm
(consistent with the host's existing approval gate and the roadmap).

### Writes (AppleScript)

`create_contact` / `update_contact` build pure AppleScript run via the shared
`runOsa` with a Contacts-specific error mapper. Settable: first/last name,
organization, nickname, note, and one or more emails/phones (with labels).
All user strings interpolated only via `esc()`.

## MCP tools

- `search_contacts(query, limit?)` → hybrid search; returns Contacts (full shape).
- `read_contact(uid)` → one contact resolved live from the AddressBook stores.
- `resolve_recipient(description, limit?)` → ranked email-bearing candidates.
- `create_contact(firstName?, lastName?, organization?, nickname?, note?, emails?, phones?)`
  → AppleScript; returns the new contact id. At least one of name/organization
  required (validated).
- `update_contact(uid, …mutable fields)` → AppleScript.

### Confirmation of writes
Not implemented in the MCP. `create_contact`/`update_contact` are gated by the
host's existing PreToolUse approval, per the platform roadmap (approval is an
orchestrator concern, not a per-connector feature).

## File structure (`apps/contacts-mcp/src`)

- `paths.ts` — AddressBook sources glob; sidecar DB path (`CONTACTS_INDEX_DB` override).
- `types.ts` — `Contact`, `ContactEmail`, `ContactPhone`, `ResolvedRecipient`.
- `addressbook-store.ts` — read-only multi-source reader + dedup/merge; `listContacts`, `getContact(uid)`, `allForIndex`.
- `index-db.ts` — sidecar schema (mirror + standalone FTS5 + `VectorStore`); upsert/delete/state/ftsSearch/allowedUids.
- `sync.ts` — incremental index + embedding; `sourceHash`, `loadEmbedConfig`.
- `search.ts` — hybrid FTS+vector+RRF (filters pre-limit).
- `resolve.ts` — `resolveRecipient` over hybridSearch (email-bearing, ranked).
- `applescript.ts` — pure create/update builders + `mapContactsError`; runners via `@steward/applescript`.
- `args.ts` — argument validation.
- `cli.ts` — `index` / `sync` / `status`.
- `index.ts` — MCP server + tool registration.
- `realtest.mts` — manual live (read + a create/delete round-trip), excluded from CI.

## Reuse (no duplication)

- `@steward/applescript` — `esc`, `runOsa` (with injected `mapContactsError`).
- `@steward/search` — `rrf`, `embedText`/`embedTexts`, `VectorStore`.
- `@steward/embedding` — stays pure (no sqlite there).
- Mirror calendar-mcp's `index-db`/`sync`/`search` structure (same patterns); do
  not import calendar-mcp internals — contacts shapes differ, but the design is
  parallel so a reader who knows calendar-mcp understands this immediately.

## Error handling

- Read: AddressBook stores missing/unreadable → actionable "grant Full Disk Access".
- Write: `mapContactsError` translates -1743 (Automation not granted → System
  Settings hint), -1728 (contact/id not found), -600 (Contacts.app not running),
  timeouts.
- Embeddings unavailable → search degrades to FTS-only, never errors.

## Testing

- **Pure logic** unit-tested against seeded temp `.abcddb`-shaped SQLite files
  (multi-source + dedup/merge), an in-memory sidecar (FTS+RRF pre-filter, sync
  idempotency, resolve ranking), and AppleScript builders with an injected
  `OsaExec` fake — the calendar-mcp pattern.
- A `realtest.mts` (excluded from CI) reads the real stores and does a
  create/delete round-trip on a real contact.

## Global constraints

- AddressBook `.abcddb` stores opened **read-only**, never written.
- `packages/embedding` stays pure (no better-sqlite3 / sqlite-vec); wiki gate stays green.
- Commit only on the feature branch; never main. Do not delete existing
  `realtest.mts` / `e2e-smoke.mts` files in other apps.
- Embeddings route through the LLM gateway by default (`local-embed`),
  `MAIL_EMBED_ENDPOINT=off` disables — consistent with the centralized wiring.
- No new TCC permission: reads use existing FDA, writes use existing Automation grant.
- All user-supplied strings interpolated into AppleScript only via `esc()`.

## Out of scope (v1)

- Contact photos, addresses, birthdays, social profiles, IM handles.
- Groups / smart groups.
- Merging contacts across sources beyond the email/uniqueid dedup heuristic.
- A background watcher (sync is on-demand / scheduled).
