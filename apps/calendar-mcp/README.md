# calendar-mcp

MCP server and CLI for reading and writing Apple Calendar events via local SQLite access and AppleScript.

## Permissions

**Full Disk Access (FDA) — required for reads.**
`list_calendars`, `search_events`, and `read_event` read directly from the Apple Calendar SQLite database at
`~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`.
Grant FDA to the process running the server (Terminal, your agent host, etc.) in
System Settings → Privacy & Security → Full Disk Access.

**Automation — required for writes.**
`create_event`, `update_event`, and `delete_event` drive Calendar.app via AppleScript (`osascript`).
The first time a write tool is called, macOS will prompt for Automation permission.
If denied, grant it in System Settings → Privacy & Security → Automation.

## CLI

```
npx calendar-mcp <command>
```

| Command | Description |
|---------|-------------|
| `index` / `sync` | Build or refresh the local search index (reads all events from Apple Calendar and upserts into `calendar-index.sqlitedb`). |
| `status` | Show how many events are in the index and where the DB lives. |

### Search index and embeddings

The `index` command populates a local SQLite index that enables hybrid keyword + semantic search via `search_events`.

Semantic embeddings are generated via the gateway `local-embed` model. The endpoint defaults to
`http://127.0.0.1:4000/v1/embeddings` (controlled by `MAIL_EMBED_ENDPOINT`). Set
`MAIL_EMBED_ENDPOINT=off` to disable embedding and build a keyword-only index.

```bash
# Build the index with embeddings (gateway must be running)
calendar-mcp index

# Build keyword-only index (no embedding endpoint needed)
MAIL_EMBED_ENDPOINT=off calendar-mcp index

# Check index status
calendar-mcp status
```

The index DB path defaults to `~/Library/Application Support/llm-wiki/calendar-index.sqlitedb` and can be
overridden with the `CALENDAR_INDEX_DB` environment variable.

## MCP tools

| Tool | Description |
|------|-------------|
| `list_calendars` | List all calendars with their account name. Requires FDA. |
| `search_events` | Search events by free-text query (hybrid keyword + semantic if the index exists) and/or time range, account, and calendar filters. Requires FDA. |
| `read_event` | Read one event by uid. Requires FDA. |
| `create_event` | Create a new calendar event. Requires Automation. |
| `update_event` | Update fields of an existing event by uid. Requires Automation. |
| `delete_event` | Delete an event by uid. Requires Automation. |

### search_events parameters

All parameters are optional and ANDed:

- `query` (string) — free-text search; uses hybrid search when the index is built, otherwise falls back to `eventsInRange`
- `start` (ISO string) — start of time range (default: 30 days ago)
- `end` (ISO string) — end of time range (default: 90 days from now)
- `account` (string) — filter by account name
- `calendar` (string) — filter by calendar name
- `limit` (number) — max results, default 20, max 100

### create_event parameters

Required: `calendar`, `summary`, `start` (ISO), `end` (ISO).
Optional: `allDay` (boolean), `location`, `description`, `url`, `recurrence`.

### Attendees limitation

AppleScript cannot send real calendar invitations. `create_event` and `update_event` do not support
an `attendees` field. To invite attendees, use the Calendar.app UI or an Exchange/CalDAV API directly.

## Destructive operations

`create_event`, `update_event`, and `delete_event` are destructive. When running under the `apps/host`
agent host, each of these tool calls is gated by the host's PreToolUse approval hook — the user must
explicitly confirm before the operation executes.

## Live test (manual only)

```bash
# Creates and immediately deletes a test event in the "Casa" calendar.
# Do NOT run in CI — it modifies real calendar data.
node --import tsx apps/calendar-mcp/realtest.mts
```

## Unit tests

```bash
cd apps/calendar-mcp && npm test
```

Tests cover: CoreData conversion, AppleStore queries, IndexDb, sync, hybrid search, AppleScript builders, and argument parsers. The `realtest.mts` is NOT included in `npm test`.
