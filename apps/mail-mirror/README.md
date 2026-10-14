# Mail Mirror

Local normalized SQLite mirror of Apple Mail's on-disk EMLX archive. Steward
searches this mirror instead of repeatedly asking AppleScript to scan the
archive. It stores message/thread identity, physical paths, body state,
attachments, mailbox roles and derived search/embedding state.

## Setup and permissions

From the monorepo root with locked dependencies installed:

```sh
node --import tsx apps/mail-mirror/src/cli.ts backfill
node --import tsx apps/mail-mirror/src/cli.ts status
```

Grant Full Disk Access to the Terminal/launcher identity reading
`~/Library/Mail/V*`. Mail data must be downloaded locally: the mirror cannot
recover a server-only body or attachment from the filesystem. Missing access is
reported as a permission error rather than assumed to mean an empty mailbox.

Defaults are `~/Library/Application Support/mail-mirror/mail.db` and sibling
`blobs/`; see `src/paths.ts` for overrides. SHA-256 content addressing lets
attachments share blob identity independently of names. The Apple Mail store
remains authoritative; the sidecar contains derived indexes and operational
promotion/embedding metadata that should not be casually discarded during use.

## Commands and freshness

| Command | Behavior |
|---|---|
| `backfill` | Import the on-disk archive recent-first. Refresh account/mailbox identity best-effort. |
| `reconcile` | Diff tracked paths/mtimes, ingest changes, remove missing paths and soft-delete a logical message only when no path remains. |
| `watch` | Long-lived filesystem-event ingestion, embedding worker and identity refresh every five minutes. |
| `embed` | Drain pending vectors in bounded batches until idle or unavailable. |
| `migrate` | Re-ingest existing tracked files and refresh account/mailbox identity. Not required after every ordinary reconcile. |
| `status` | Message/body/thread/vector/account/role counts and database path. Opens the local store; not a purely external health probe. |

The packaged scheduler runs `reconcile` every ten minutes and `embed` every 15
minutes by default. It does not start the filesystem watcher. Delays can exceed
those intervals when jobs fail, time out or skip overlapping ticks. A watcher
improves latency but does not replace reconciliation.

For an optional standalone watcher:

```sh
node --import tsx apps/mail-mirror/src/cli.ts watch
```

The historical `launchagent/com.llmwiki.mailmirror.plist` is a standalone option:
replace its repo-path placeholder before installing it. Do not start a second
copy of the same watcher or scheduler as part of the packaged setup. In a
standalone setup, arrange periodic reconciliation separately; the old plist
alone is not the full Steward background pipeline.

## Retrieval and embedding lifecycle

The mirror maintains FTS5 word and trigram indexes plus optional sqlite-vec
vectors. Message-ID is the preferred identity; threading uses existing identity,
Gmail metadata, RFC reply references and subject/participant/time heuristics.
Several mailbox paths can refer to one logical message, including Gmail labels.

Embedding source is subject plus body, capped at 2,000 characters by default
(`MAIL_EMBED_MAX_CHARS`). Source hashes suppress unchanged work. The batch size
is 32 (`MAIL_EMBED_BATCH`); rejected members are retried individually and remain
pending if unavailable. Vectors with incompatible dimensions are reset. Changing
the model to another model with the same dimension is not itself a complete
hash-based re-embedding migration.

Default embeddings use `http://127.0.0.1:4000/v1/embeddings`, model `local-embed`;
`MAIL_EMBED_ENDPOINT=off` disables them. Role classification similarly uses the
gateway unless `MAIL_CLASSIFY_ENDPOINT=off`. Explicit direct endpoints can send
content outside the default gateway and bypass its ledger. `watch` starts the
embedding worker when enabled; `backfill` does not automatically drain vectors.

## Body completeness and reads

`body_state` describes what was ingested: `full`, `partial` or `none`. A partial
EMLX download flag does not prove its extracted text is truncated. Mail MCP
serves useful mirrored bodies directly; only a non-full body with fewer than
20 trimmed characters attempts a live AppleScript read. It adopts only a richer
usable result for that response, without persisting it back into the mirror.
Failure keeps the available mirrored text. Compact search pages do not expose
body state; individual reads do.

Mail.app's download settings can improve local coverage. The historical
benchmark in the root README is a dated dataset measurement, not a promise that
half of every user's archive will be partial.

## Validation and related processing

```sh
npm test -w @steward/mail-mirror
```

Deterministic tests cover ingestion, multipath deletion, MIME/EMLX parsing,
threading, indexes and embedding recovery. Live smoke is manual and uses real
Mail data. See [root data journeys](../../README.md#incoming-email-apple-mail-to-local-mirror)
for the full flow. Mail promotion writes wiki sources separately; mirroring or
embedding a message does not authorize a reply or imply durable wiki ingestion.
