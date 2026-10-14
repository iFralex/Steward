# Steward Host

Node host for the Pi agent (`@earendil-works/pi-coding-agent`) and all Steward
clients. It serves HTTP/WebSocket on loopback port 4317, optionally HTTPS for
phones, and owns chats, tool policy, approval sessions, files, push, speech,
voice coordination, watch delivery and system diagnostics.

## Development setup

Use Node 22.19+ for the current Pi dependency. From the monorepo root:

```sh
npm ci
npm ci --prefix apps/llm-wiki
npm run mcp:build -w llm-wiki
```

Start long-lived services in separate terminals:

```sh
npm run dev -w @steward/llm-gateway
# Start the wiki desktop app separately, or its Tauri development runtime:
npm run tauri -w llm-wiki -- dev
npm run dev -w @steward/host
VITE_HOST_URL=ws://127.0.0.1:4317 npm run dev -w @steward/web
```

The wiki Tauri development path additionally needs Rust/Xcode build tooling.
Enable wiki Settings → API + MCP, configure its token, and pass
`LLM_WIKI_API_TOKEN` to the host. That token is independent of host/browser
pairing. The wiki MCP defaults to the compiled
`apps/llm-wiki/mcp-server/dist/src/index.js`; source MCP connectors use `tsx`
outside packaged mode. Wiki provider settings also need separate configuration
if chat/embeddings should route through the gateway.

Vite clients must pair with the host token. For auto-paired loopback use, build
the web UI and let the host serve it:

```sh
npm run build -w @steward/web
npm run dev -w @steward/host
```

Open `http://127.0.0.1:4317`. The default static directory is `apps/web/dist`.
See [root setup](../../README.md#setup) for mail bootstrap, scheduler, permissions
and native packaging.

## Configuration boundaries

`src/config.ts` loads `apps/host/.env` without overriding existing environment
values. Copy [the example](.env.example) for host overrides. The packaged
launcher reads `~/Library/Application Support/Steward/config.env` and passes
settings to its children; a standalone host does not load that file itself.

| Setting | Default / meaning |
|---|---|
| `HOST_PORT` | `4317`, HTTP listener on `127.0.0.1`. |
| `HOST_ALLOWED_ORIGINS` | Additional browser origins; same-origin host traffic remains accepted. Vite localhost origins are allowed outside production. |
| `GATEWAY_BASE_URL`, `HOST_TIER` | `http://127.0.0.1:4000/v1`, `tier-5`. |
| `GATEWAY_API_KEY` | Explicit shared key enables gateway bearer validation on model POST routes; unset gateway remains loopback compatibility mode. Host fallback is `sk-local`. |
| `STEWARD_AUTH_TOKEN` | Overrides persisted host pairing token, otherwise generated under `Steward/auth-token`. |
| `APPROVAL_TIMEOUT_MS` | `300000`, fail closed when approval cannot be obtained. |
| `STEWARD_TLS_CERT`, `STEWARD_TLS_KEY`, `STEWARD_TLS_PORT` | Optional HTTPS listener on all interfaces; default HTTPS port is host port + 1. |
| `LLM_WIKI_API_BASE_URL`, `LLM_WIKI_API_TOKEN` | Wiki endpoint (`http://127.0.0.1:19828`) and independent API credential. |
| `STEWARD_CALENDAR_BRIDGE_DIR` | Launcher-owned EventKit IPC root; absent in ordinary standalone development. |
| `CHATS_DIR`, `UPLOAD_DIR`, `HOST_STATIC_DIR` | Optional storage/static overrides. |

Provider API keys such as `DEEPSEEK_API_KEY` belong in the gateway process.
Host `.env` is not a universal environment loader for separately started jobs.
Endpoint overrides and independent wiki providers can bypass gateway routing.

## Sessions, authority and persistence

Each chat has a persisted Pi session. Each client connection owns a `Session`
that routes pending approvals/questions by chat/request ID. `ChatManager.runTurn`
serializes turns per chat and returns explicit success/failure for headless
callers; WebSocket clients receive the streaming protocol. Quick Send cannot
silently approve writes. Voice uses the same agent and a deterministic host-owned
spoken approval exchange.

The interactive policy defaults to `gate`; explicitly safe tools run directly
and hard-denied tools cannot be approved. Connector MCP processes do not enforce
the host's UI approval themselves, so invoking one outside Steward moves that
responsibility to the external caller. Agent-watch grants add argument checks and
durable action claims for future execution; they do not authorize arbitrary MCP
names or arguments.

Chats/sessions, write journal, watch claims and Action review state are primary
operational data. Audit is best-effort with bounded heuristic redaction of its
payload and summary/source strings, not a redacted replacement for those stores. Mail/Calendar journal
confirmation is separate from a tool returning successfully. For Calendar,
EventKit Full Access, database Full Disk Access and AppleScript Automation are
distinct permissions. See [write reliability](../../README.md#approval-and-write-reliability).

## Checks

```sh
npm run typecheck -w @steward/host
npm test -w @steward/host
```

Host unit tests cover policy, sessions, connectors, voice/watch coordination and
route behavior with injected dependencies. Live train/phone/data tests are
separate opt-in flows. The root README describes their scope; do not substitute
real external actions for deterministic verification.
