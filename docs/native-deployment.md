# Native installation and updates (Apple Silicon)

Managed deployment targets Apple Silicon, macOS 14+ and Node 22.19+ for the current Pi dependency. Steward and Ringback run natively on ARM Homebrew; Docker is not required.
The deployment command keeps immutable application and Ringback releases under
`~/Library/Application Support/Steward/deploy/releases/`, and exposes the active
app at `/Applications/Steward.app`. The first cutover preserves an existing
non-managed app bundle inside `deploy/releases/legacy-.../` for rollback.
Chats, watches, audit, usage, settings, uploads and Keychain credentials stay
in their existing locations, outside the release directories.

1. Run `npm run deploy:doctor` to inspect the prerequisites and current voice
   runtime. Install native ARM Homebrew at `/opt/homebrew` if it is missing.
2. Quit Steward. Run `npm run deploy:install -- --sip-user=YOUR_LINPHONE_NAME`
   for a first installation. This builds the app from locked npm dependencies,
   builds Ringback and pjproject in a separate release directory, prompts for
   the SIP password and stores it in Keychain. It launches the app and waits
   for the host health endpoint. Existing Linphone/Tailscale sign-in and macOS
   permissions remain interactive setup steps.
3. For later releases run `npm run deploy:update`. It copies only the SIP
   identity (not the password) from the old Ringback configuration, builds a
   new runtime, and verifies it before switching. The app must be quit for the
   final cutover; `--stage-only` prepares a release while Steward is running.
   Then `node tools/steward-deploy.mjs activate RELEASE_ID` performs the switch.
4. Run `npm run deploy:verify` or `npm run deploy:rollback` if needed. The
   previous app and its Ringback launcher remain available. A failed startup
   smoke test asks the new app to quit and rolls back automatically once it has
   stopped. A release is never switched while an existing host is responding.

Before switching, the installer runs the operational backup under
`deploy/backups/RELEASE_ID/`: ten known Steward databases (chats, watches, Audit,
Usage, Actions, write journal, Mail, promotion, Calendar and Contacts), session
files including externally referenced sessions, configuration and persistent
Steward/wiki settings. SQLite uses its online backup API per database. The
manifest records source paths, checksums and missing optional sources; publication
uses staging plus rename, directories `0700`, regular files `0600`. A backup
failure prevents cutover. Configuration and sessions contain sensitive data.

Use `npm run backup:full -- --output=/PATH/TO/NEW/BACKUP --wiki=/PATH/TO/VAULT`
to additionally preserve wiki content, external configured sources, uploads and
Mail blobs. `npm run backup:operational -- --output=/PATH/TO/NEW/BACKUP` creates
an operational snapshot independently. Keychain and Apple authoritative stores
remain external; symlinks are preserved without copying their external targets.
Stop writers for stable content and a shared cross-store point in time: individual
SQLite consistency is not one transaction across the entire application.

Rollback never silently restores older data. Schema changes must remain backward
compatible; an explicit restore uses the manifest mappings after stopping writers.

The installer verifies the app bundle structure, ARM launcher, Ringback
runtime, and the pinned Whisper model checksum. The app packaging also checks
the bundled Whisper model checksum. A weekly ARM macOS workflow builds a clean
bundle and rehearses installation, update and rollback without SIP credentials.
The rehearsal uses `--no-launch` for the install/update cycle; it exercises
packaging, layout, verification and rollback mechanics, not successful live host
startup. It cannot test an actual Linphone call, Tailscale route convergence or
privacy prompts; those remain release smoke tests on the real devices.

The packaged launcher requests Calendar Full Access for EventKit and guides Full
Disk Access for database reads. Mail/Contacts and Calendar's AppleScript
compatibility path additionally need Automation. Launch progress and health
checks do not prove all those permissions were granted. Only managed children
are supervised; externally running services remain outside launcher ownership.

Set `STEWARD_VOICE_EXIT_NODE_ID` in
`~/Library/Application Support/Steward/config.env` to the Tailscale peer ID of
an online peer advertising exit-node capability, or choose it in System voice
network settings. An arbitrary tailnet phone is not necessarily an eligible
exit node. The peer ID is independent of the app build; if that peer is
re-registered, update the saved choice/override. This is a call-scoped fallback,
not a requirement for ordinary phone PWA access.

## Vault backup versus code rollback

The wiki's optional Git backup is separate from deployment snapshots. It runs
every six hours while the wiki process stays alive and sends the current vault
to its configured remote after `gh api` verifies that it is a private GitHub
repository. Missing CLI/auth, public visibility or unverifiable remotes abort
before staging/push. It does not back up Steward's operational stores.
Rollback switches code/runtime references and intentionally retains newer data.
See [backup boundaries](../README.md#backup-boundaries) before planning a full
recovery, particularly for the write journal and durable watch action claims.
