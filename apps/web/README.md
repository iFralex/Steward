# Steward Web

React 19, TypeScript, Vite and Tailwind client for the Steward host. The same
application runs in a desktop browser, the launcher's WebKit window and an
installed phone PWA. Agent execution, credentials for model providers, tool
policy and durable chat state belong to the host, not the browser.

## Run and connect

Run from the monorepo root with Node 22.19+ and installed locked dependencies:

```sh
npm run dev -w @steward/host
# In another terminal:
VITE_HOST_URL=ws://127.0.0.1:4317 npm run dev -w @steward/web
```

The host also needs the gateway and configured MCP services; see the
[root setup](../../README.md#development-run). Open `http://localhost:5173`.
`VITE_HOST_URL` is a Vite build/dev-time WebSocket URL. HTTP routes derive their
base by replacing `ws`/`wss` with `http`/`https`. Without the override, both use
the page's own host and select secure protocols when the page uses HTTPS. Vite
does not proxy host routes and cannot auto-pair by injecting the host token.

For normal host-served use:

```sh
npm run build -w @steward/web
npm run dev -w @steward/host
```

Open `http://127.0.0.1:4317`. Build without a development `VITE_HOST_URL` override
so the same artifact works over localhost and phone HTTPS. The host serves
`apps/web/dist` by default; `HOST_STATIC_DIR` overrides that directory. The
launcher uses the built UI when present and otherwise falls back to Vite.

## Authentication and connection lifecycle

Token resolution prefers a pairing URL's `?token=`, then the loopback-only
`window.__STEWARD_TOKEN__` injected by the host, then browser `localStorage`
(`steward-token`). The URL token is consumed and removed from the address bar.
Paired clients authenticate HTTP and WebSocket requests; HTTP 401 clears the
stored token and returns the user to pairing. The token is a shared credential,
not a per-device identity or model-provider key.

`host-socket.ts` implements `@steward/protocol`: chat selection/history, streaming
text, tool lifecycle, questions, approvals, files and Action Center state.
Reconnect requests refresh server-backed history/state and reapply saved Action
filters. Pending approvals belong to the old host connection and are not replayed
into a new connection; unresolved requests still fail closed on their timer. A persisted transcript is
not a snapshot of a still-running browser session.

## User surfaces and state

- Chat list and streamed conversations, visible tool inputs/results/errors and
  transcript export. Tool cards retain effective approved inputs and, when
  different, the original request for inspection.
- Approval cards with approve/edit/deny/revise and structured question cards.
  Leaving an optional argument absent does not insert an empty argument.
- Email, file, event and search cards rendered from fenced card JSON. Files use
  registered host tokens; native open/reveal affordances are for local clients.
- Action list/detail, proposal execution/revision and open-in-chat. Include-done
  and hide-expired flags persist under `steward.actions.showDone` and
  `steward.actions.hideExpired`; SQLite applies filters before result limits.
- Usage, Audit and live System diagnostics, pairing/push settings, voice preview
  and call-network settings. Action settings are fetched from the host and
  persisted in Action Center metadata, independently of browser UI language.
- Uploads and microphone recording; the host owns extraction/transcription and
  does not run the agent in the browser.

Browser preferences and pairing live in localStorage. Chats, Actions, operational
journals and ledgers are host-side primary state. Clearing browser storage loses
pairing/preferences, not those server records. The phone is a client and needs
an awake reachable Mac for agent work and background notification generation.

## PWA and mobile

`vite.config.ts` uses `vite-plugin-pwa` with `injectManifest` and the custom
`src/sw.ts`. It precaches application assets and handles Web Push and notification
navigation; it does not cache the personal API as an offline replica. When an
existing window is available it receives the click payload. Cold-open URLs carry a validated Action/chat identifier; the app consumes it
once and waits for an authenticated host connection before navigating. Service
worker development mode is disabled. Test installation/push with a production
build on a secure origin, not only Vite HMR.

The default manifest starts at `/` with standalone display. Phone access uses the
host's optional HTTPS listener and pairing; see
[mobile setup](../../docs/mobile-access.md). VAPID subscriptions are host-managed.
Changing a browser preference does not grant the agent permission to execute a
sensitive tool.

## Validation

```sh
npm run typecheck -w @steward/web
npm run lint -w @steward/web
node --import tsx --test apps/web/test/*.test.ts
```

There is no workspace `test` script. The Node tests cover pure inline-card and
approval-input helpers, not full browser/PWA behavior. `build` also regenerates
icons before TypeScript and Vite; avoid treating it as a read-only documentation
check. A UI release additionally needs browser checks for streaming/reconnect,
approval edits, mobile navigation and service-worker notification links.
