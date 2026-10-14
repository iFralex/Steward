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

Build a local production app bundle:

```sh
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

On the first packaged launch, Steward explains why local Mail, Calendar, and
document tools need Full Disk Access and offers a button that opens System
Settings directly on **Privacy & Security → Full Disk Access**. macOS requires
the user to grant this permission explicitly, so the launcher cannot enable it
itself. The launcher also proactively asks for full Calendar access through
EventKit. Calendar writes run inside the launcher and the Node calendar service
uses a private per-user bridge. Requesting permission during onboarding reduces
unattended prompting, but it cannot guarantee the user granted access. Full Disk
Access remains separate from Calendar Full Access. The AppleScript Calendar
compatibility path still needs Automation, as do Mail/Contacts writes.

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

The packaged app uses its own permission identity. The Full Disk Access prompt
is shown once but is not a permission verification; the user must enable access
manually and restart if required. Closing the window hides the UI, while quitting
stops the bridge/supervision and managed children. Release packaging/deployment
is distinct from backing up user data; see
[native deployment](../../docs/native-deployment.md).
