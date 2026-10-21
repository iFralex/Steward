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

`body_state` describes download state: `full`, `partial` or `none`. Extraction
quality is recorded independently. A full download can have no readable text;
a partial EMLX file can already contain the useful message body. Individual
reads expose `bodyState` and available `bodyExtraction` metadata; compact search
pages do not.

The reader first recovers old or inconsistent extractions from the local MIME
source. A live AppleScript read is attempted only when fewer than 20 trimmed
characters remain and the body is empty, explicitly unavailable, or an
insufficient legacy extraction from a non-full file. Confirmed short replies
and known image-only bodies do not trigger repeated live reads. A richer usable
live result replaces the response body without persisting that AppleScript
replacement; failure keeps the available mirrored text.

MIME import compares the original plain and HTML representations without sender
rules, known compatibility phrases, LLM calls or embedding similarity. The HTML
renderer preserves text, paragraphs, links, tables and SVG labels, excludes
scripts, styles, hidden elements and tracking images, and labels image alt text.
It does not fetch remote resources or pretend to perform OCR. Mislabeled plain
HTML documents and fragments use the same renderer.

Only exact, ordered block coverage and compatible link destinations allow an
alternative to be suppressed. Otherwise both versions are retained and labelled;
read responses include offsets to jump to either version through body pagination.
Approximate overlap is diagnostic only. Resource limits and image-only bodies are
explicitly flagged. `body_extraction` stores version, source, quality, reason and
hashes of the MIME source and extracted text, independently of `body_state`.

Reconciliation upgrades up to 50 old extractions per pass even when file mtimes
have not changed. Reads also try the local MIME source before a live read when
extraction is old or its text hash is inconsistent. Writable reads persist the
result; read-only connections return it without changing the database.

To audit a batch across all senders, run
`node --import tsx tools/eval-mail-body.mts --pending --limit=500`.
To test a previous repair corpus plus 100 recent controls, use
`--reference=PATH/TO/before.json --controls=100` instead. Reports and plans are
private files under `tmp/mail-body-v2-*`. Apply a reviewed plan with
`node --import tsx tools/eval-mail-body.mts --apply-plan=PATH/TO/plan.json`.
This saves prior rows, verifies unchanged MIME source hashes and previous bodies,
updates search indexes and verifies reads. Changed bodies invalidate embeddings
for the regular worker; metadata-only upgrades do not. Unavailable sources and
low comparison coverage are reported for review. The old `repair-mail-html.mts`
entry point now delegates to the versioned audit; old phrase-based plans cannot
be applied as versioned extraction results.

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
