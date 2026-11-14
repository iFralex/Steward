# SQLite runtime override (12 November 2026)

**Update, November 14, 2026:** release `2026-11-14T01-36-57-788Z-7304093e` includes the current Usage worker and better-sqlite3 13.1.1 / SQLite 3.54.1. Its bundled SQLite and sqlite-vec 0.1.9 were verified before cutover; the old SQLite `NODE_OPTIONS` preload was removed from the installed configuration. Gateway origin diagnostics remain in the packaged source; `STEWARD_GATEWAY_PEER_BIN` points to the existing local peer helper. The override instructions below describe the preceding installation and remain relevant when rolling back to it, not the active release. The pre-update operational snapshot is on ORICO under `Steward-deploy-backups/`.

Steward's installed Node backend originally loaded better-sqlite3 11.10.0 / SQLite 3.49.2. The verified runtime is better-sqlite3 13.1.1 / SQLite 3.54.1, including native sqlite-vec 0.1.9 compatibility on this Mac. Package manifests and the root npm lockfile now pin 13.1.1; Node >=22 is required. The macOS SQLite command line executable is unaffected.

The installed signed app is preserved. Its launcher reads `NODE_OPTIONS=--import=file:///.../tools/sqlite-runtime-preload.mjs` from `~/Library/Application Support/Steward/config.env` for its Node children. The preload redirects better-sqlite3 only for the app's services, mail-gate releases and Usage summary worker. The MCP SDK filters the parent environment; the preload forwards only its own import flag to Node children with trusted Steward service entrypoints. Unrelated shell-launched Node programs retain their own runtime; no extra host credentials are forwarded. Actual activations, including process and worker IDs and the probed SQLite version, are recorded in `.local-models/sqlite-runtime/activations.jsonl`.

The same preload patches three specific Usage expressions in the installed host **in memory**, after verifying its SHA256 and unique replacement anchors. The production host therefore uses the new read-only worker and queries only tool statistics for system status. The equivalent TypeScript changes are included in source and the normal app packager includes the new worker. History aggregation performs one streaming pass, coalesces simultaneous requests, and caches summaries for 30 seconds. The 12.4 million historical LLM rows are retained.

Build with `node tools/build-sqlite-runtime.mjs` after installing the pinned native dependency under `.local-models/sqlite-runtime` and providing esbuild. The generated manifest and worker files are local deployment assets: preserve them and this checkout while the override is active. This override is tied to the current installed host bundle. Before a normal app update, remove the preload flag from `NODE_OPTIONS`, deploy the updated source and verify its native SQLite version. Do not blindly regenerate the expected host hash against an unfamiliar bundle.

Config backups are private copies under `~/Library/Application Support/Steward/sqlite-runtime-backups/`. To disable the override, quit Steward normally, remove only this `--import` flag from the current config (preserving GTE settings), and restart. Reverting the runtime does not require reverting the recovered database. For any DB replacement, first close every connection and handle WAL/SHM files; never replace an open SQLite file.

Recovery evidence, permanent original and recovered snapshots on ORICO, limitations and live verification are documented in `.local-evals/usage-recovery/report.md`. Do not discard the original archive. Recovery cannot recreate physically missing tail pages or events never logged after corruption.

## Origin diagnostics deployment

The override also loads a rebuilt gateway with origin diagnostics, verified by
SHA256 against both the installed original and the replacement source. The build
script compiles `tools/gateway-peer.c` with the local C compiler and sets its path
for the gateway. This does not modify the signed app. Its deployment record and
the actual before/after wiki search checks are under `.local-evals/usage-origin/`.
Removing only the `gateway` entry from the runtime manifest and restarting the
gateway disables this extension while retaining the SQLite update and Usage
worker. The manifest before this extension is kept in
`.local-models/sqlite-runtime/origin-backup/runtime.json`.
