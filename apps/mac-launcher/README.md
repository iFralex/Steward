# macOS Launcher

Native macOS 14+ shell for the web + host app. It keeps the existing host
WebSocket protocol unchanged and adds a system-wide shortcut to show or hide a
dedicated WebKit window.

Default behavior:

- Opens `http://127.0.0.1:4317`.
- Registers `Command+Shift+Space` as the global shortcut.
- Lives in the menu bar.
- Closing the window hides it; the menu-bar item can reopen or quit it.
- Starts Ollama if `http://127.0.0.1:11434` is not reachable and `ollama` is
  available on the machine.
- Checks that the local embedding model `bge-m3` is installed.
- Starts the host if `http://127.0.0.1:4317/health` is not reachable.
- Starts the model gateway on `http://127.0.0.1:4000` if it is not reachable.
- If `apps/web/dist/index.html` does not exist, starts the Vite web dev server
  and opens `http://127.0.0.1:5173` instead.

## Run

For normal development:

```sh
npm run launcher:mac
```

Embeddings still use Ollama's `bge-m3` model. Install it once with:

```sh
ollama pull bge-m3
```

For a host-served production-like UI, build the web UI first:

```sh
npm run build -w @steward/web
npm run launcher:mac
```

To point it at a different UI URL:

```sh
LLM_WIKI_LAUNCHER_URL=http://127.0.0.1:5173 swift run --package-path apps/mac-launcher StewardLauncher
```

To disable service startup and only open the configured URL:

```sh
LLM_WIKI_LAUNCHER_START_SERVICES=0 npm run launcher:mac
```

## Package

Create the persistent local signing identity once (macOS may ask for Keychain
authorization), then build a local production app bundle:

```sh
npm run signing:setup
npm run package:mac
open "dist/mac/Steward.app"
```

The bundle contains the launcher, the built web UI, compiled service entrypoints,
a Node runtime, and a minimal runtime dependency closure. It does not copy the
whole repo `node_modules`; it includes the native packages that cannot be bundled
safely (`better-sqlite3`, `sqlite-vec`, and their runtime dependencies). In
bundled mode the launcher starts the model gateway, host, and scheduler from
`Contents/Resources` instead of running `npm run dev`.

Processes started by the launcher are supervised for their full lifetime. A
service that exits is restarted with exponential backoff (up to 60 seconds).
Services with an HTTP health endpoint are checked every 15 seconds and restarted after three consecutive
failed checks; the scheduler, which has no HTTP endpoint, is monitored by process
liveness. Intentional app shutdown cancels pending restarts before terminating
the managed children. A child that survives at least 60 seconds resets the
exit-backoff count; an unhealthy child gets a five-second grace period before a
forced kill. Only processes the launcher starts are supervised: it does not
adopt an externally running host/gateway/Ollama. Process/HTTP liveness is not a
proof that every background job or MCP tool works.

Native menus, startup text and permission alerts use keyed English/Italian
`Localizable.strings` catalogs. `InfoPlist.strings` also localizes macOS Calendar
and Automation prompts. An explicit app language (including English on an Italian
Mac) takes precedence for app-owned text. Permission diagnostics in the web UI
use its i18next catalogs.

Every packaged launch checks Calendar authorization and attempts real local-data
reads. Calendar requests finish before a Full Disk Access guide appears. A denied
Calendar request offers **Privacy & Security → Calendars**; restricted access is
reported separately. Full Disk Access guidance appears when local reads fail with
a permission error. Missing data or other I/O errors are reported as unverified,
not as granted or denied. The legacy “dialog already shown” preference is ignored.

Checks run again when Steward becomes active after Settings. “Not now” suppresses
the same reminder for this session, and the next launch checks again. Revoking a
previously observed grant makes the reminder actionable again. **Check Permissions…**
in the app and menu-bar menus retries manually and reports unavailable probes.
The Full Disk Access guide reveals the running bundle in Finder so it can be
added directly, including during migration from an old signing identity. macOS
may require quitting and reopening Steward after changing Full Disk Access.
The app cannot grant permission itself or force macOS to repeat a denied native
prompt. Directory reads establish access to that location, not unrestricted disk
access; Calendar database health additionally opens and reads the actual store.

Calendar writes run inside the launcher through a private per-user EventKit
bridge. Full Disk Access for local stores and Calendar Full Access are separate.
The AppleScript Calendar compatibility path still needs Automation, as do
Mail/Contacts writes. Services remain usable while permissions are incomplete.

Packaging signs all Mach-O helpers, nested bundles, then the outer app, and
verifies the complete signature. The local certificate fingerprint is pinned in
`~/Library/Application Support/Steward/signing/identity.json`; its private key
stays in the user Keychain. Builds reuse it automatically and fail if it is
missing, expired or untrusted, instead of generating a new identity. An existing
identity can be selected explicitly with `STEWARD_SIGNING_IDENTITY=SHA1`.
This is local signing, without Developer ID/notarization. Preserve the Keychain
identity (including its private key) and manifest when migrating the build Mac;
copying the public certificate alone cannot restore signing capability. The
initial switch from ad hoc signing may require granting permissions again.

Run `node --test tools/mac-signing.test.mjs` to verify that changed binaries retain
the same designated requirement and that resource/helper tampering is rejected.
Run `swift test --package-path apps/mac-launcher` for access-probe and reminder
lifecycle tests. Native permission dialogs and persistence across a real app
update still require an interactive macOS smoke test; signing tests do not prove
a particular TCC authorization was granted.

Set `PACKAGE_DEBUG=1 npm run package:mac` to include service sourcemaps in the
bundle.

Put secrets and local overrides in:

```text
~/Library/Application Support/Steward/config.env
```

Logs are written to:

```text
~/Library/Logs/Steward/
```

## Calendar bridge lifecycle

The launcher starts `CalendarEventKitBridge` and passes
`STEWARD_CALENDAR_BRIDGE_DIR` to its children. The default private root is
`~/Library/Application Support/Steward/calendar-bridge/`. Node publishes UUID
requests by atomic rename; Swift serializes processing and responses. A request
left in `processing/` on restart is reported with an unknown outcome rather than
replayed. Requests expire before execution; caller timeout withdraws an unclaimed request.
Once claimed, an operation can finish after timeout and remains uncertain. The write
journal and later Calendar index reconciliation preserve that uncertainty.

A standalone host cannot enable EventKit simply by naming a directory; the
launcher must own a running bridge. Standalone development uses AppleScript
unless explicitly connected to that runtime. See
[Calendar MCP](../calendar-mcp/README.md) for backend selection, recurrence scope
and confirmation limitations. The bridge is a local same-user IPC boundary,
not a network listener or an isolation boundary from another same-user process.

The packaged app uses its own persistent signing identity. Closing the window hides the UI, while quitting
stops the bridge/supervision and managed children. Release packaging/deployment
is distinct from backing up user data; see
[native deployment](../../docs/native-deployment.md).
