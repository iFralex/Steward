# Native installation and updates (Apple Silicon)

Steward and Ringback run natively on ARM Homebrew; Docker is not required.
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

Before switching, the installer makes SQLite-consistent snapshots of the
known chats, watcher, audit, usage and Action Center databases under
`deploy/backups/RELEASE_ID/`. Rollback does **not** silently restore those files:
that would discard events created after the update. Database schema changes
must remain backward-compatible; restoring a snapshot is an explicit recovery
operation to be planned if a future migration is not reversible.

The installer verifies the app bundle structure, ARM launcher, Ringback
runtime, and the pinned Whisper model checksum. The app packaging also checks
the bundled Whisper model checksum. A weekly ARM macOS workflow builds a clean
bundle and rehearses installation, update and rollback without SIP credentials.
The workflow cannot test an actual Linphone call or phone permissions; those
remain release smoke tests on the real devices.

Set `STEWARD_VOICE_EXIT_NODE_ID` in
`~/Library/Application Support/Steward/config.env` to the Tailscale peer ID of
your iPhone. That identity is no longer tied to the app build; if the phone is
re-registered and its peer ID changes, update this one setting.
