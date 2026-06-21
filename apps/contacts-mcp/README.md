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
contacts-mcp index
```

This syncs all contacts into a local SQLite index at
`~/Library/Application Support/llm-wiki/contacts-index.sqlitedb` and generates
semantic embeddings via the gateway `local-embed` model.

To disable embeddings (keyword-only FTS search):

```
MAIL_EMBED_ENDPOINT=off contacts-mcp index
```

Check index status:

```
contacts-mcp status
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
| `limit` | number | no | Max results (default 20, max 50) |

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

Destructive write operations (`create_contact`, `update_contact`) are gated by
the host's **PreToolUse approval hook**. The agent must receive explicit user
confirmation before any write is executed.

## Live test (manual only)

`realtest.mts` creates a throwaway contact and immediately deletes it. It is
**not** part of `npm test` and must never run in CI:

```
node --import tsx apps/contacts-mcp/realtest.mts
```
