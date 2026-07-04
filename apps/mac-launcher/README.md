# macOS Launcher

Small native macOS shell for the web + host app. It keeps the existing host
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
LLM_WIKI_LAUNCHER_URL=http://127.0.0.1:5173 swift run --package-path apps/mac-launcher LLMWikiLauncher
```

To disable service startup and only open the configured URL:

```sh
LLM_WIKI_LAUNCHER_START_SERVICES=0 npm run launcher:mac
```

## Package

Build a local production app bundle:

```sh
npm run package:mac
open "dist/mac/LLM Wiki.app"
```

The bundle contains the launcher, the built web UI, compiled service entrypoints,
a Node runtime, and a minimal runtime dependency closure. It does not copy the
whole repo `node_modules`; it includes the native packages that cannot be bundled
safely (`better-sqlite3`, `sqlite-vec`, and their runtime dependencies). In
bundled mode the launcher starts the model gateway, host, and scheduler from
`Contents/Resources` instead of running `npm run dev`.

Set `PACKAGE_DEBUG=1 npm run package:mac` to include service sourcemaps in the
bundle.

Put secrets and local overrides in:

```text
~/Library/Application Support/LLM Wiki/config.env
```

Logs are written to:

```text
~/Library/Logs/LLM Wiki/
```
