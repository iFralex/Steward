# Calendar MCP

Read Apple Calendar's local SQLite store, build a hybrid search sidecar, and
perform host-approved writes through the launcher's EventKit bridge or an
AppleScript compatibility path. Never write directly to Apple's database.

## Permissions and runtime

| Capability | Permission / runtime |
|---|---|
| Read calendars/events and sync index | Full Disk Access for the process reading `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`. |
| EventKit create/update/delete | Running Steward launcher (macOS 14+) and Calendar **Full Access** in Privacy & Security → Calendars. |
| AppleScript compatibility writes | Calendar.app Automation permission for the invoking process. |

The packaged launcher proactively requests EventKit access and explains Full
Disk Access. Standalone Terminal/Node invocations have a separate privacy
identity. Missing FDA does not authorize replacing database reads with a
framework write or disabling the host approval gate.

`STEWARD_CALENDAR_BRIDGE_DIR` is set by the launcher for managed children. Its
presence selects bridge-capable dispatch; it is not a liveness probe. A failed
bridge write is returned to reconciliation, never blindly retried through
AppleScript after an uncertain native effect.

The host's MCP bridge forwards this variable explicitly through its per-service
environment allowlist, together with Calendar index/journal paths and shared
embedding settings. The SDK's default stdio environment alone does not inherit
these application settings.

System diagnostics call the private `steward/calendarStatus` method on the running
connector; it is not advertised as an agent tool. It probes database readability
and uses the native `status` IPC method to report bridge reachability and Calendar
authorization separately. `status` works without Full Access, does not prompt or
read events, and waits up to 2 s (the host bounds the whole request to 5 s).
Missing/unresponsive/older bridges leave authorization unverified. A ready MCP
catalog is not proof of write access; failed access checks produce a System-page
warning. Full Access still does not make a read-only calendar writable.

## CLI and index

From the monorepo root:

```sh
node --import tsx apps/calendar-mcp/src/cli.ts sync
node --import tsx apps/calendar-mcp/src/cli.ts status
# Keyword-only sync, without gateway embeddings:
MAIL_EMBED_ENDPOINT=off node --import tsx apps/calendar-mcp/src/cli.ts index
```

`index` and `sync` read all current event rows, upsert text/metadata, remove
missing rows and update changed embeddings. Embeddings use the shared
`MAIL_EMBED_ENDPOINT`/`MODEL`/`API_KEY`/`DIM` settings, defaulting to gateway
`http://127.0.0.1:4000/v1/embeddings`, model `local-embed`, with attribution
`calendar-mcp / embed`. These variable names are shared with Mail/Contacts;
they are not Calendar-only overrides.

`CALENDAR_INDEX_DB` overrides the default
`~/Library/Application Support/steward/calendar-index.sqlitedb`. If absent,
legacy `llm-wiki/calendar-index.sqlitedb` is moved best-effort when no current
index exists. The sidecar stores FTS/vectors and historical UID aliases; deleting
it rebuilds search data but loses historical identity mappings.

## Read tools

| Tool | Input / output |
|---|---|
| `list_calendars` | Stable `id`, title, account and type. Prefer the ID for writes. |
| `search_events` | Optional `query`, `start`, `end`, `account`, `calendar`, `limit`, `offset`; compact events plus page continuation. Default 10, maximum 20. |
| `read_event` | `uid`, optional `occurrenceStart`; full event or null. Resolves a historical UID through the sidecar when available. |

Input date-times require RFC 3339 with explicit `Z` or `±HH:MM` and normalize to
UTC. Outputs use the Mac's local timezone with the date-specific offset. Date-only
or floating local strings are rejected. All-day create boundaries should be
local midnight with explicit offsets, including the applicable DST offset.

Time browsing matches half-open overlap (`event.end > start`, `event.start < end`),
by default 30 days back to 90 ahead. A configured bridge handles explicit ranges
and query-free browsing through EventKit occurrence expansion, then applies
account/calendar/text filters and pagination. Windows above 366 days or above
1,000 occurrences fail explicitly. Each returned occurrence has `occurrenceStart`.
Indexed hybrid text search without explicit dates remains an unbounded entity
search over stored rows. Compatibility range reads apply lexical query terms;
when relevant recurring masters exist, they reject the request rather than imply
complete occurrence availability.

## Write tools and compatibility

| Tool | Arguments and result |
|---|---|
| `create_event` | Required `summary`, `start`, `end`, plus either `calendarId` or unique legacy `calendar` title. Optional `allDay`, location, description, URL, recurrence and alarms. Returns `uid`, `operationId`. |
| `update_event` | Required `uid` and at least one effective change. Optional summary, start/end, location, description, URL, recurrence, alarms, scope and occurrenceStart. Returns `ok`, `operationId`. |
| `delete_event` | Required `uid`, optional scope and occurrenceStart. Returns UID, operation ID and `pending_confirmation` on backend success. |

Alarms are non-negative minutes before start, rounded to integers; update `[]`
clears them; native update `recurrence: ""` clears recurrence. Create requires end after start. Update rejects a UID-only or
ineffective empty update, and validates a changed time against the live unchanged
boundary. EventKit validates effective times again before committing. Attendees and real invitations are
not exposed by these schemas.

For create, EventKit selects the stable `calendarId`. The legacy title is
resolved only when unique. Compatibility creation uses a title after resolving
that ID and rejects duplicate titles: Calendar's scripting identifier selector
is unreliable on current macOS. Update/delete resolve known old UIDs before
backend dispatch.

Duplicate-title compatibility failures distinguish `CALENDAR_EVENTKIT_UNAVAILABLE`
(bridge configuration missing) from `CALENDAR_RRULE_UNSUPPORTED` (native recurrence
representation unavailable). The former can occur for a nonrecurring event and
must not be described as a recurrence error. Native permission failures use
`CALENDAR_FULL_ACCESS_REQUIRED`; they require the Calendars permission rather than
Full Disk Access. All three reject before executing the mutation.

EventKit supports `scope: thisEvent` (default) or `futureEvents`; recurring
updates/deletes require an explicit `occurrenceStart`. AppleScript updates reject
recurring targets and `futureEvents`; compatibility deletion rejects future scope. Create/update choose EventKit
when a bridge is configured and the recurrence is representable; delete chooses
it whenever the bridge is configured.

The bridge RRULE subset includes `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`,
`COUNT` or `UNTIL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYWEEKNO`, `BYYEARDAY` and
`BYSETPOS`. Unsupported or duplicate fields make the rule unrepresentable and
select compatibility; they are not silently removed. Calendar.app may still
reject a compatibility rule. `UNTIL` accepts a basic date or UTC date-time.

## Bridge protocol, journal and confirmation

The default IPC root is
`~/Library/Application Support/Steward/calendar-bridge/` with `requests/`,
`processing/`, `responses/`. Directories use `0700`, Node request files `0600`.
UUID request JSON is published by rename; Swift polls every 100 ms and claims it
by moving it to `processing/`. Node polls responses every 50 ms for up to 30 s
and removes the consumed response. Swift serializes operations and commits via
EventKit. It checks Full Access before executing, including `ping`; the read-only
`status` authorization probe is the exception and returns no calendar contents.

Restarted processing requests get `outcomeUnknown` without replay. Requests
carry an expiry checked before execution. On timeout an unclaimed request is
withdrawn and reported unexecuted; a claimed/running request remains uncertain
and can complete later. No automatic replay or backend switch follows uncertainty. This is private local-user IPC, not a same-user security sandbox.

The connector journals executable inputs before dispatch and stores the backend
result as `script_returned`, a historical state name also used for EventKit.
Reconciliation resolves UID aliases and compares supplied fields and sorted
alarms. All-day dates use local civil-day matching. Native recurrence comparison
requires one supported canonical RRULE; recurrence presence alone is insufficient.
Recurring/future-scope operations require native read-back of the selected
occurrence. This verifies observable rule state, not all future instances.

Sidecar confirmation requires a completed source sync started after backend
completion (milliseconds; conservative extra second for legacy records). Metadata,
deletions and the completed marker publish in one transaction before optional
embedding work. Delete confirmation additionally requires a pre-write target
baseline. Fresh native read-back can avoid waiting for that sync. A create with
no returned UID needs one unambiguous field match from a bounded candidate set.
Calendar never automatically re-executes writes; the normal confirmation ceiling
is 12 checks. Exhaustion is lack of confirmation, not rollback.

See [root Calendar internals](../../README.md#calendar-write-transport-and-identity)
and [the resolution register](../../docs/readme-code-audit.md).

Host approval is enforced in the host's deterministic tool wrapper, not by the
standalone MCP server. External MCP clients own their own authorization boundary.
Journal inputs are operational sensitive data; Audit copies have separate,
heuristic redaction.

## Validation

```sh
npm test -w @steward/calendar-mcp
```

Tests use fixtures for parsers, CoreData, search/index identity, EventKit client
IPC and sync. Scheduler confirmation tests cover evidence/attempt bounds.
`realtest.mts` and the EventKit harness under `tools/eventkit-validation/` are
manual-only: they can request native permissions and modify real events. They
are not documentation checks or part of deterministic CI verification.
