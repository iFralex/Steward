# mail-mirror

Local SQLite mirror of Apple Mail (sub-project 1/3). See
`docs/superpowers/specs/2026-06-18-mail-mirror-store-design.md`.

## Setup

1. Install deps: `npm install` (from repo root or this folder).
2. Grant **Full Disk Access** to the process that runs the watcher (the
   `node`/`tsx` binary, or the Terminal/daemon launching it) in
   System Settings -> Privacy & Security -> Full Disk Access.
3. Initial backfill (recent-first): `npm run -w @steward/mail-mirror exec -- node --import tsx src/cli.ts backfill`
   or `cd apps/mail-mirror && node --import tsx src/cli.ts backfill`.
4. Check progress: `node --import tsx src/cli.ts status`.

## Live sync (LaunchAgent)

1. Edit `launchagent/com.llmwiki.mailmirror.plist`, replacing
   `REPLACE_WITH_ABSOLUTE_PATH` with the absolute repo path.
2. Copy to `~/Library/LaunchAgents/` and load:
   `cp launchagent/com.llmwiki.mailmirror.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.llmwiki.mailmirror.plist`
3. The watcher keeps the DB live; run `reconcile` nightly (add a second
   LaunchAgent with `StartCalendarInterval`, or cron) to catch missed changes.

## Commands

- `backfill` — ingest all on-disk `.emlx` (recent-first).
- `watch` — live FSEvents sync.
- `reconcile` — diff disk vs DB; ingest new, soft-delete removed.
- `status` — counts (messages, full bodies, threads) and DB path.

## Coverage note

~Half of messages may be `.partial.emlx` (body not downloaded). Those rows have
`body_state` of `partial`/`none`; sub-project 2 fills them on demand via the
AppleScript fallback (`src/applescript-fallback.ts`). To raise local coverage,
enable "Download all messages / attachments" per account in Mail settings.
