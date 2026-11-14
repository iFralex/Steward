# Rust versus Node: Usage aggregation prototype

This is a standalone, read-only experiment. It does not replace the Usage worker or change production routing. The November 13, 2026 results and limitations are documented in the local report `.local-evals/rust-benchmark/report.md`.

## Reproduce on this installation

Prerequisites: macOS, Node 24, `rustc`, the existing verified better-sqlite3 runtime and its preload under `.local-models/sqlite-runtime`. The scripts are tied to the local Steward paths and SQLite module installation; they are not a general-purpose package. Use a quiet system, with at least 1.2 GB of temporary free space. Snapshot files are created exclusively and must not already exist.

```sh
mkdir -p .local-evals/rust-benchmark
rustc -O --edition 2021 tools/rust-benchmark/totals.rs -o .local-evals/rust-benchmark/totals-rust
rustc -O --edition 2021 tools/rust-benchmark/groups.rs -o .local-evals/rust-benchmark/groups-rust
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs tools/rust-benchmark/export.mjs .local-evals/rust-benchmark/records.bin
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs tools/rust-benchmark/export-groups.mjs .local-evals/rust-benchmark/groups.bin
python3 tools/rust-benchmark/compare.py
python3 tools/rust-benchmark/compare-groups.py
python3 tools/rust-benchmark/test.py
```

The two exports occur at different times and therefore can contain different numbers of rows. Within each comparison both programs read the exact same file. Files contain counters, cost, timestamps, day and locally assigned numeric group identifiers, but no message text or customer identifiers. They still describe private operational usage; keep the snapshots under the Git-ignored, private `.local-evals/` directory. `compare-groups.py` uses `/usr/bin/time -l` for process RSS and CPU; macOS sandbox restrictions can require permission to read process statistics.

The grouped prototype uses a 56-byte little-endian record: four uint32 counters, one float64 cost, four uint32 group IDs, one uint32 local-day value, padding and one float64 timestamp in milliseconds. Service/action IDs must be below 256 for the JavaScript composite key. Both programs validate this constraint; production requires a general representation and a proper SQLite integration. Five dimensions are checked: service, service/action, model, tier, and day/service for the selected 90-day window.

The scripts compare all group keys and integer aggregates exactly and floating-point sums with a 1e-9 USD tolerance. They alternate four process runs and report every sample, median wall time, CPU time and peak RSS. Page-cache state is not controlled. Day values are precomputed; SQLite query time, full Usage response, model execution, UI rendering and application startup are not included. The additional `groups-string.mjs` and `.local-evals/rust-benchmark/group-string-keys.json` retain the initial string-key experiment.

`observe-live.py` calls local `/usage`, `/health` and `/system/status`, records timing and an aggregate process snapshot, and never prints the authentication token. `observe-mail.mjs` runs the FTS and thread-selection queries in read-only mode; only timing and result counts are saved. `profile-summary.mjs` instruments the existing Usage summary and requires the locally built `.local-models/sqlite-runtime/tests/usage-ledger.mjs`; its iteration timing includes SQLite stepping, JavaScript grouping and instrumentation overhead. These independent observations must not be added together or treated as a controlled end-to-end Rust comparison.

## Direct SQLite and complete worker payload

The second prototype opens a consistent snapshot of the Usage database directly using the same SQLite **3.54.1** amalgamation bundled with the local better-sqlite3 package. It produces the complete `LedgerSummary` worker payload, including ordered groups, recent calls, tools, voice and provider attempts. It runs as a standalone, single-shot process; it is not connected to the production host. The host's separately calculated `costByKind`, gateway rates lookup, HTTP transport and browser rendering are outside this comparison.

```sh
mkdir -p .local-evals/rust-benchmark/build
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs tools/rust-benchmark/snapshot.mjs .local-evals/rust-benchmark/usage-snapshot.db
cc -O2 -DSQLITE_THREADSAFE=1 -c .local-models/sqlite-runtime/node_modules/better-sqlite3/deps/sqlite3/sqlite3.c -o .local-evals/rust-benchmark/build/sqlite3.o
ar rcs .local-evals/rust-benchmark/build/libsqlite3.a .local-evals/rust-benchmark/build/sqlite3.o
rustc -O --edition 2021 tools/rust-benchmark/summary.rs -L .local-evals/rust-benchmark/build -o .local-evals/rust-benchmark/summary-rust
node tools/rust-benchmark/build-node.mjs
python3 tools/rust-benchmark/test-summary.py
python3 tools/rust-benchmark/compare-summary.py .local-evals/rust-benchmark/usage-snapshot.db EPOCH_MILLISECONDS all 3
python3 tools/rust-benchmark/compare-summary.py .local-evals/rust-benchmark/usage-snapshot.db EPOCH_MILLISECONDS 30 2
python3 tools/rust-benchmark/compare-summary.py .local-evals/rust-benchmark/usage-snapshot.db EPOCH_MILLISECONDS 7 2
```

`snapshot.mjs` uses SQLite's online backup API and refuses to overwrite an existing snapshot. The database copy contains the full private ledger, not just anonymized counters; it is owner-readable under the Git-ignored private directory and occupied approximately 2.55 GiB in the reported experiment. That local snapshot was removed after the measurements to conserve space. A new snapshot is static, so each run against it gets exactly the same data. Fix the same epoch for every implementation and window; this controls the lookback and daily cutoff. Keep at least enough space for the complete database copy and normal service operation.

`summary-node-original.mjs` bundles the existing `UsageLedger.summary`; `summary-node-optimized.mjs` substitutes `aggregate-optimized.ts`, which interns repeated composite keys instead of serializing them on every row. The optimized version is an experimental copy: check it against the production aggregator when changing that source. The Rust binary performs the main aggregation in Rust and runs the other read queries through SQLite JSON functions. It uses local civil time for day buckets and preserves group ordering including ties. It is a prototype, not a production-ready substitute: SQLite compile flags differ from the Node package, lifecycle, errors, integer/UTF-8 edge cases, configuration and integration require additional work.

The comparator checks every field recursively, preserves all array ordering, compares integer values exactly, and permits a floating tolerance of 1e-9 absolute or 1e-12 relative. Synthetic checks cover an empty database, null model/tier, Unicode, stream booleans, three lookback windows and the Europe/Rome DST change. Actual snapshots are also compared for all, 30 and 7 days. Runs alternate order and include opening SQLite, computation and JSON serialization, plus startup of each isolated process. They do not control the OS page cache or background workloads. The two SQLite builds use the same version but not necessarily identical compilation options or configuration; RSS is process RSS and excludes shared system page-cache accounting.

## Installed MCP and background-job assessment

See [the migration assessment](../../docs/rust-migration-assessment.md) for the scope, results and limitations. The following probes call the **installed local services and real data**, except for synthetic Documents/Shell inputs; train probes also make public read-only ViaggiaTreno requests. Local embedding calls add zero-cost ledger entries. Tool responses, private IDs, message contents and file paths are discarded rather than saved, but the programs necessarily hold returned data in memory during a call. Do not run if that access is not intended. They do not send mail, change Actions, modify Calendar or Contacts, or execute other write tools.

```sh
python3 tools/rust-benchmark/mcp-probe.py
python3 tools/rust-benchmark/mcp-extended.py
python3 tools/rust-benchmark/mcp-wiki-probe.py
python3 tools/rust-benchmark/mail-extra.py
python3 tools/rust-benchmark/train-probe.py
python3 tools/rust-benchmark/summarize-mcp.py
python3 tools/rust-benchmark/services-probe.py
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs tools/rust-benchmark/observe-jobs.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs tools/rust-benchmark/action-retries.mjs
python3 tools/rust-benchmark/scheduler-log.py
```

The scripts read the local Steward configuration for authentication and force benchmark embeddings through loopback `local-embed`. Output is aggregate-only under `.local-evals/mcp-rust-benchmark/`. The next scripts open local databases in read-only mode, traverse Mail without writing, and process email text in memory; do not run without access to the intended stores. They require Full Disk Access for the original Mail files. The MIME build uses an extracted `mailparser-from-installed-bundle.mjs` under the local, ignored `.local-evals/mail-backlog/` directory; that artifact is not distributed with the repository. The SQL index probe changes only an in-memory temporary database, not the Mail mirror.

```sh
node tools/rust-benchmark/build-backfill-profile.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 STEWARD_PROFILE_LIMIT=100000 STEWARD_PROFILE_OUTPUT=.local-evals/mcp-rust-benchmark/backfill-profile-final.json node --import ./tools/sqlite-runtime-preload.mjs .local-models/sqlite-runtime/lib/backfill-profile.mjs
node tools/rust-benchmark/build-mime-profile.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs .local-models/sqlite-runtime/lib/mime-profile.mjs
node tools/rust-benchmark/build-job-hotspots.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs .local-models/sqlite-runtime/lib/job-hotspots.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs tools/rust-benchmark/index-probe.mjs
python3 tools/rust-benchmark/gte-probe.py
node tools/rust-benchmark/build-safety-tests.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs --test --test-concurrency=1 .local-evals/mcp-rust-benchmark/tests/*.mjs
```

Some commands require macOS process inspection, network permission or access to protected Mail and Calendar stores. The GTE probe loads the production local model and can use significant unified memory; it uses generic text, not email. Neither CPU time nor RSS alone proves that porting a wrapper will improve end-to-end latency. Several tests use few repeated observations and uncontrolled system caches, so report individual samples instead of treating the warm median as a stable service-level percentile.

### Mail follow-up

`mail-index-copy.mjs` creates a disposable **private database containing actual message bodies and paths**, approximately 726 MiB in this assessment, under the ignored directory. It refuses to overwrite an existing copy. Its source connection is read-only; index and rollback-only update trials modify the copy. Run only with sufficient disk space and protect or remove the copy when it is no longer needed. The other index scripts require that copy. The hash-first builders produce experimental bundles and do not change production. `hash-first-e2e.mjs` also requires the bundled `Store` used by the experiment; mirror and state are opened read-only and external decisions are simulated. The MIME stale probe reads real `.emlx` files and writes only aggregate results.

```sh
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs tools/rust-benchmark/mail-index-copy.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs tools/rust-benchmark/mail-stale-index.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs tools/rust-benchmark/mail-index-writes.mjs
STEWARD_HASH_TEST_ENTRY=tools/rust-benchmark/hash-first-parity.ts node tools/rust-benchmark/build-hash-first-test.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs .local-evals/mcp-rust-benchmark/tests/promoter-baseline.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs .local-evals/mcp-rust-benchmark/tests/promoter-hash-first.mjs
STEWARD_MIME_ENTRY=tools/rust-benchmark/mime-stale-profile.ts STEWARD_MIME_BUNDLE=.local-models/sqlite-runtime/lib/mime-stale-profile.mjs node tools/rust-benchmark/build-mime-profile.mjs
STEWARD_SQLITE_RUNTIME_TEST=1 node --import ./tools/sqlite-runtime-preload.mjs .local-models/sqlite-runtime/lib/mime-stale-profile.mjs
```
