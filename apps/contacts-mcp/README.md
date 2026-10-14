# contacts-mcp

MCP server and CLI for Apple Contacts — hybrid keyword+semantic search, recipient resolution, and AppleScript-backed write operations.

## Permissions

**Reads** require **Full Disk Access** for the process (Terminal or the host app).
The server reads one or more AddressBook SQLite stores from
`~/Library/Application Support/AddressBook/` (both the top-level DB and per-source
UUIDs under `Sources/`). If no stores are found, read tools return an actionable
error: _"No AddressBook stores found. Grant Full Disk Access."_

**Writes** (`create_contact`, `update_contact`) go through AppleScript and require
**Automation permission** for Contacts. Grant it in
System Settings → Privacy & Security → Automation.

## Building the search index

Run this once (and again whenever your contacts change significantly):

```
node --import tsx apps/contacts-mcp/src/cli.ts index
```

This syncs all contacts into a local SQLite index at
`~/Library/Application Support/steward/contacts-index.sqlitedb` and generates
semantic embeddings via the gateway `local-embed` model. Run the commands below
from the monorepo root. `CONTACTS_INDEX_DB` overrides the sidecar path; a legacy
`llm-wiki/contacts-index.sqlitedb` is migrated best-effort if no current file exists.
There is no periodic Contacts sync job in the default scheduler: refresh the
index explicitly when contacts change. Writes do not synchronously refresh it.

To disable embeddings (keyword-only FTS search):

```
MAIL_EMBED_ENDPOINT=off node --import tsx apps/contacts-mcp/src/cli.ts index
```

Check index status:

```
node --import tsx apps/contacts-mcp/src/cli.ts status
```

## Deduplication

Contacts that appear in multiple AddressBook sources are merged using an
**email-first** heuristic: if two records share a primary email address they are
treated as the same contact, merged under a single `uid`, and their `sources`
array lists every source UUID they came from.

## MCP Tools

### `search_contacts`

Hybrid keyword + semantic search over indexed contacts.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `query` | string | yes | Free-text query |
| `limit` | number | no | Page size (default 8, max 15) |
| `offset` | number | no | Rank offset returned as `page.nextOffset` |

### `read_contact`

Read one contact by its `uid` (the sidecar uid assigned during indexing).

| Argument | Type | Required |
|----------|------|----------|
| `uid` | string | yes |

### `resolve_recipient`

Resolve a free-text description (e.g. _"the accountant"_, _"my dentist"_) to a
ranked list of email-bearing candidates. **Returns candidates for confirmation —
it does not auto-pick.** The agent or user must confirm which address to use.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | string | yes | Natural-language description |
| `limit` | number | no | Max candidates (default 5, max 50) |

Each result contains `uid`, `displayName`, `organization`, `email`, and a
relative `score`.

### `create_contact`

Create a new contact via AppleScript. Needs at least one of `firstName`,
`lastName`, or `organization`.

| Argument | Type | Required |
|----------|------|----------|
| `firstName` | string | no |
| `lastName` | string | no |
| `organization` | string | no |
| `nickname` | string | no |
| `note` | string | no |
| `emails` | `{address, label?}[]` | no |
| `phones` | `{number, label?}[]` | no |

Returns `{ id }` — the Contacts app `personId` assigned to the new contact.

### `update_contact`

Update fields of an existing contact. **`personId` is the Contacts app id
(returned by `create_contact` or inspectable in Contacts.app) — not the sidecar
`uid` used by the index.**

| Argument | Type | Required |
|----------|------|----------|
| `personId` | string | yes |
| `firstName` | string | no |
| `lastName` | string | no |
| `organization` | string | no |
| `nickname` | string | no |
| `note` | string | no |
| `emails` | `{address, label?}[]` | no |
| `phones` | `{number, label?}[]` | no |

## Write safety

Writes (`create_contact`, `update_contact`) are gated by the host's deterministic
**tool execution wrapper**. Direct MCP invocations outside the host must supply
their own authorization policy. A previously approved agent-watch grant may
permit a constrained future write without another interactive approval.

Contacts writes are not part of the Mail/Calendar `write-ops` confirmation loop;
a returned AppleScript result is not independently confirmed against a refreshed
Contacts index. Do not equate a sidecar UID with a native person ID or assume
index search reflects an immediately preceding write.

## Live test (manual only)

`realtest.mts` creates a throwaway contact and immediately deletes it. It is
**not** part of `npm test` and must never run in CI:

```
node --import tsx apps/contacts-mcp/realtest.mts
```

## Validation and embedding configuration

```sh
npm test -w @steward/contacts-mcp
```

`MAIL_EMBED_ENDPOINT`, `MAIL_EMBED_MODEL`, `MAIL_EMBED_API_KEY` and `MAIL_EMBED_DIM`
are shared embedding settings, defaulting to gateway `local-embed`. Calls carry
`contacts-mcp / embed` attribution. An overridden direct endpoint bypasses gateway
metering. Recipient resolution returns ranked email-bearing candidates rather
than selecting or authorizing one automatically.
