# Steward — local-first personal agent for macOS

Steward is a **personal AI assistant that runs on your Mac**. It can chat with you, read your personal knowledge base, search Apple Mail, Calendar, Contacts and local files, prepare actions such as email replies or calendar events, and ask for your approval before doing anything sensitive.

The simplest way to describe it is:

> Steward is a private assistant with memory. It keeps a local wiki about your work and life, watches for useful signals in your mail and calendar, and turns them into searchable knowledge or ready-to-approve actions.

The technical way to describe it is:

> Steward is a local-first agent platform made of a React/PWA client, a Node host running a Pi-based agent, MCP connectors for local data sources, a self-hosted OpenAI-compatible LLM gateway, background indexing/distillation jobs, and a vendored LLM Wiki desktop app used as long-term inspectable memory.

Everything important runs locally. Your data is stored on your machine. Network egress is limited to the model providers configured behind the gateway, plus optional private phone access through Tailscale/Web Push.

> `apps/llm-wiki` is a vendored fork of the LLM Wiki desktop app. The surrounding Steward host, web UI, connectors, scheduler, gateway, launcher, approval system, mobile access, and automation layer are original to this repo.

## What Steward Does

### For a non-technical user

Steward gives you one place to ask questions and approve actions.

You can ask things like:

- "Find the invoice PDF the accountant sent me last month."
- "Reply to Anna and say Friday afternoon works."
- "Am I free Thursday between 14:00 and 17:00?"
- "What did we decide about the solar-panel certification?"
- "Show me the latest file in Downloads and attach it to an email."
- "Remind me what this client asked for in the last thread."

Steward can then:

- search your email, attachments, contacts, calendar, local files and wiki;
- explain what it found;
- show rich cards for emails, files, events and search results;
- prepare an email, reply, scheduled email, calendar event or file operation;
- show an approval card before a write happens;
- let you approve, edit, deny, or ask for a revised proposal;
- keep a background Action Center of things that may need your attention;
- notify your phone when there is an action waiting for you;
- keep a personal wiki of durable facts, decisions, commitments and source links.

The assistant does not silently send mail or mutate your files. It can propose those actions, but the host gates them with deterministic code and waits for your confirmation.

### For a technical user

Steward is a monorepo of local services:

- `apps/web` is the browser/PWA client.
- `apps/host` serves the web app, owns sessions, runs the agent, gates tools, stores chat history, exposes usage/system routes, and bridges UI events over WebSocket.
- `apps/llm-gateway` exposes one OpenAI-compatible endpoint with model capability tiers.
- MCP servers expose Mail, Calendar, Contacts, Shell, LLM Wiki and Action Center tools.
- `apps/scheduler` runs periodic background jobs.
- local SQLite stores mirror mail, calendar/contact indexes, action items, write-operation journals, chats and usage.
- `apps/mac-launcher` packages all of this as a menu-bar macOS app.

The agent uses MCP tools through `packages/mcp-bridge`. Tool calls are classified by a default-deny policy as allowed, gated or denied. Read-only queries can run directly; side-effecting operations become approval cards in the UI.

## Main Workflows

### Chat With Local Context

The chat UI is not a generic chatbot. It is connected to local tools:

- LLM Wiki tools for long-term memory and source-backed knowledge.
- Mail tools for search, reading threads, opening `message://` links, saving attachments, sending, replying and scheduling emails.
- Calendar tools for availability checks, search and event CRUD.
- Contacts tools for resolving people from names, emails and AddressBook records.
- Shell tools for safe file discovery and read-only command execution.
- Action Center tools for inspecting and executing pending proposed work.

Messages stream in the UI. Tool calls appear as visible cards, including status, inputs, outputs, duration and errors. The transcript can be copied as JSON for debugging.

### Approval Cards

When the agent wants to perform a sensitive operation, the host turns the request into an approval card.

Examples of gated actions:

- send an email;
- reply to a thread;
- send an email later;
- create, update or delete a calendar event;
- write to the clipboard;
- run a file-mutating shell command;
- execute an Action Center proposal.

Approval cards support:

- approve;
- approve with edits;
- deny with note;
- request revision.

This means the model can suggest an action, but deterministic host code decides whether it can run.

### Action Center

The Action Center is a background inbox of work Steward thinks may need you.

The scheduler scans recent mail and creates action items such as:

- reply-needed email threads;
- scheduling requests;
- follow-ups;
- proposed email responses;
- calendar proposals;
- items that should be reviewed or dismissed.

Each item stores the source thread, summary, status, proposed steps and diagnostics. The web UI shows new/read/done items. Selecting an item marks it read, opens the detail pane, and lets the agent refine or execute the proposal through the same approval flow used in chat.

The Action Center can also send Web Push notifications to a paired phone when something needs approval.

### Personal Wiki Memory

Steward uses LLM Wiki as durable memory. Instead of only retrieving raw documents at answer time, the wiki incrementally turns sources into Markdown pages that can be inspected, edited and searched.

The wiki keeps:

- raw sources;
- generated wiki pages;
- `index.md` as a catalog;
- `log.md` as an operation trail;
- `purpose.md` to describe why the wiki exists;
- `schema.md` to define page rules and structure;
- YAML frontmatter with source traceability;
- Obsidian-compatible `[[wikilinks]]`;
- graph relationships between pages.

The LLM Wiki fork includes:

- desktop Tauri app;
- project templates;
- two-step ingest;
- persistent ingest queue;
- folder import;
- source folder auto-watch;
- multimodal image extraction and captioning;
- optional MinerU PDF parsing;
- vector semantic search;
- graph visualization;
- Louvain community detection;
- graph insights and Deep Research;
- lint/review flows;
- Chrome web clipper;
- local HTTP API on `127.0.0.1:19828`;
- bundled MCP server for external agents.

Steward also has `apps/wiki-add`, a small CLI and Finder Quick Actions helper for adding files or folders into the wiki.

### Mail Mirror And Mail Promotion

Steward does not ask Apple Mail to search everything live each time. It maintains a local mirror.

`apps/mail-mirror` reads Apple Mail's on-disk `.emlx` store and builds:

- SQLite message/thread tables;
- full-body records where locally available;
- soft-delete tracking;
- thread resolution;
- attachment blob storage;
- trigram keyword indexes;
- vector indexes through sqlite-vec;
- embedding state;
- mailbox role classification;
- fallback AppleScript reads for partial messages.

`apps/mail-promoter` then scans mail threads and promotes durable knowledge into the wiki. It filters noise, extracts decisions, commitments, facts, useful documents and selected attachments, then writes source notes with `message://` backlinks so you can inspect the original email.

### Calendar And Contacts

Calendar and Contacts are also indexed locally.

`apps/calendar-mcp` reads Apple's Calendar database, builds a searchable index, and can create/update/delete events through AppleScript when approved.

`apps/contacts-mcp` reads AddressBook data, deduplicates people, labels fields, supports hybrid search, and exposes `resolve_recipient` so the agent can turn "Marco" or "Anna from Polimi" into the right address before proposing an email.

### Local Files And Shell

`apps/shell-mcp` gives the agent constrained access to the filesystem.

It supports:

- finding files;
- read-only command execution;
- gated write commands.

The read-only command runner accepts familiar shell-like syntax including pipes, but it does not spawn a real shell. It parses the command itself, uses allow-listed binaries with explicit argv, and rejects dangerous constructs such as command substitution and redirection. Sensitive paths are blocked by shared path policy.

### Mobile Access

Steward can be used from a phone without exposing your Mac to the public internet.

The intended setup is:

- Tailscale connects the Mac and phone on a private network.
- The host keeps plain HTTP on localhost and can expose an HTTPS listener on all interfaces when `STEWARD_TLS_CERT` and `STEWARD_TLS_KEY` are configured, for example with a Tailscale certificate.
- The web UI is installed as a PWA.
- A shared auth token pairs the phone.
- Web Push uses VAPID keys generated by the host.
- Push notifications can open directly to a pending action.

The Mac remains the agent runtime. The phone is only a client. See [docs/mobile-access.md](docs/mobile-access.md).

### Voice And Quick Send

The web app includes microphone recording and transcription support.

The host can transcribe uploaded audio through local `whisper.cpp` when configured with:

- `STEWARD_WHISPER_BIN`;
- `STEWARD_WHISPER_MODEL`;
- `STEWARD_SPEECH_LANGUAGE`;
- optional timeout variables.

There is also a `/quick-send` path for shortcuts such as an iPhone Action Button. It can send text or audio into a headless chat runner. Gated writes still require approval; unattended sensitive actions time out rather than silently executing.

## Architecture

```text
                    browser / PWA / WebKit window
                ┌────────────────────────────────────┐
                │ apps/web                            │
                │ chat, approvals, actions, usage,    │
                │ system, mobile pairing, push, audio │
                └─────────────────▲──────────────────┘
                                  │ WebSocket + HTTP
                                  │ packages/protocol
┌────────────────────┐    ┌───────┴────────────────────────────┐
│ apps/mac-launcher  │───▶│ apps/host :4317                     │
│ menu bar app,      │    │ Pi agent sessions, auth token,      │
│ shortcut, service  │    │ tool policy, approvals, chat store, │
│ health/startup     │    │ usage ledger, file registry, push,  │
└────────────────────┘    │ speech, Action Center executor      │
                          └───────┬────────────────────▲────────┘
                                  │ MCP stdio bridge    │ OpenAI-compatible
                                  │                     │
        ┌─────────────────────────┴──────────┐  ┌──────┴──────────────────┐
        │ MCP connectors                      │  │ apps/llm-gateway :4000  │
        │ llm-wiki, mail, calendar, contacts, │  │ tier-1..tier-6,         │
        │ shell, action-center                │  │ local-embed, rates      │
        └──────────────▲──────────────────────┘  └─────────▲───────────────┘
                       │ local DB / AppleScript / files       │
        ┌──────────────┴──────────────────────────────────────┴────┐
        │ apps/scheduler                                             │
        │ mail reconcile, mail embed, mail distill, calendar sync,   │
        │ write confirmation/retry, Action Center scan               │
        └────────────────────────────────────────────────────────────┘
```

There are three operating planes:

1. **Interactive plane** — the user chats in the web UI; the host runs an agent and exposes tools through MCP. Read actions can run directly. Writes become approval cards.
2. **Background plane** — the scheduler keeps local indexes fresh, embeds mail, distills durable knowledge into the wiki, scans for action items and confirms write operations.
3. **Reliability plane** — writes are journaled before execution, confirmed against local mirrors afterwards, and retried safely if they did not actually land.

## Components

| Path | Purpose |
|---|---|
| [apps/web](apps/web/) | React + Vite + PWA UI. Provides chat, chat list, mobile layout, Action Center, approval/question cards, tool cards, rich cards, file uploads/chips, audio recording, Usage page, System page, phone pairing, notification controls and service worker. |
| [apps/host](apps/host/) | Node host on `:4317`. Serves the built UI, owns WebSocket sessions, runs Pi agent sessions, loads MCP tools, applies the tool policy, stores chats, records usage, handles approvals/questions, serves tokenized files, registers uploaded/local files, manages auth/pairing, push, speech transcription and system status. |
| [packages/protocol](packages/protocol/) | Dependency-free event contract between host and clients. Keeps chat, approvals, questions, tool calls, files and Action Center state portable across future clients. |
| [packages/mcp-bridge](packages/mcp-bridge/) | Converts stdio MCP servers into Pi custom tools named like `mcp__server__tool`. |
| [apps/llm-gateway](apps/llm-gateway/) | Local OpenAI-compatible gateway on `:4000`. Provides `tier-1` through `tier-6`, `local-embed`, `/rates`, `/health`, `/v1/models`, chat completions and embeddings. Routes to Ollama and DeepSeek by default. |
| [apps/llm-wiki](apps/llm-wiki/) | Vendored LLM Wiki desktop app and MCP server. Provides persistent Markdown memory, ingest, search, graph, lint, review, Deep Research and local API. |
| [apps/mail-mirror](apps/mail-mirror/) | Local SQLite mirror of Apple Mail. Handles backfill, watch, reconcile, embeddings, thread resolution, mailbox roles, partial-message fallback and attachment blobs. |
| [apps/mail-mcp](apps/mail-mcp/) | Mail MCP connector. Searches, reads, resolves threads, opens mail URLs, saves attachments and performs approved send/reply/scheduled-send through AppleScript and write journaling. |
| [apps/mail-promoter](apps/mail-promoter/) | Mail-to-wiki pipeline. Triage, distillation, note generation, selected attachment sync and promotion state. |
| [apps/action-center](apps/action-center/) | Scans recent mail into actionable items with LLM-prepared proposals. Exposes CLI and MCP surfaces and persists status in SQLite. |
| [apps/calendar-mcp](apps/calendar-mcp/) | Calendar connector. Reads Calendar data, builds hybrid search index and performs approved event writes through AppleScript/write-ops. |
| [apps/contacts-mcp](apps/contacts-mcp/) | Contacts connector. Reads AddressBook data, deduplicates, labels, indexes and resolves recipients. |
| [apps/shell-mcp](apps/shell-mcp/) | Safe shell/files connector. Finds files, runs constrained read-only commands, and gates write commands. |
| [apps/scheduler](apps/scheduler/) | Background daemon. Runs periodic CLI jobs with no-overlap scheduling, timeouts and isolated errors. |
| [packages/write-ops](packages/write-ops/) | Journal and confirm/retry state machine for AppleScript writes such as mail sends/replies/scheduled sends and calendar CRUD. |
| [packages/usage-ledger](packages/usage-ledger/) | Per-turn usage ledger. Stores tokens, cost, per-tier cost attribution and tool timings/errors for the Usage page. |
| [packages/embedding](packages/embedding/) | Shared embedding client with batching and retry. |
| [packages/search](packages/search/) | Shared hybrid-search helpers: reciprocal rank fusion and sqlite-vec vector store primitives. |
| [packages/applescript](packages/applescript/) | Shared `osascript` runner with escaping, timeouts and transient-error handling. |
| [packages/sensitive-path](packages/sensitive-path/) | Shared path guard for secrets and sensitive filesystem locations. |
| [apps/wiki-add](apps/wiki-add/) | CLI and Finder Quick Actions for adding files/folders to LLM Wiki sources. |
| [apps/mac-launcher](apps/mac-launcher/) | SwiftPM menu-bar app. Opens a WebKit window, registers `Command+Shift+Space`, checks/starts services, packages a self-contained `.app`, and reads production overrides from `~/Library/Application Support/Steward/config.env`. |

## LLM Gateway And Models

All services call the same local gateway instead of each app knowing provider details.

The public model names are capability tiers:

- `tier-1` — local Ollama chat model, useful as the weakest/local rung.
- `tier-2` to `tier-5` — DeepSeek V4 Flash by default.
- `tier-6` — DeepSeek V4 Pro by default.
- `local-embed` — local embedding model, normally Ollama `bge-m3`.

Callers choose a tier. The gateway maps that tier to real providers. Non-streaming requests can fall back across tiers on failure. Streaming requests retry only before bytes are emitted. Usage and rates are exposed so the host can show cost in the Usage page.

## Ports And Endpoints

| Port | Service |
|---|---|
| `4317` | Steward host HTTP on localhost. WebSocket protocol, static web app, `/health`, `/upload`, `/usage`, `/file/<token>`, `/resolve`, `/system/*`, `/settings/notification-lang`, `/push/*`, `/quick-send`, `/transcribe`. |
| `4318` | Optional Steward HTTPS listener for phone/Tailscale when `STEWARD_TLS_CERT` and `STEWARD_TLS_KEY` are set; override with `STEWARD_TLS_PORT`. |
| `4000` | LLM gateway. `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`, `/rates`, `/health`. |
| `11434` | Ollama. Used for local embeddings and optional local chat. |
| `19828` | LLM Wiki local API. |
| `5173` | Vite dev server for `apps/web`. |

By default, host and gateway are local-only. Phone access is opt-in and uses the host's HTTPS listener over a private network such as Tailscale.

## Data On Disk

Most Steward data lives under `~/Library/Application Support/`:

| Location | Contents |
|---|---|
| `Steward/auth-token` | Shared token for authenticated host routes and paired clients. |
| `Steward/vapid.json` | Persisted VAPID keys for Web Push. |
| `Steward/push-subscriptions.json` | Registered browser/PWA push subscriptions. |
| `Steward/config.env` | Packaged launcher/service overrides and secrets. |
| `mail-mirror/mail.db` and `mail-mirror/blobs/` | Mirrored mail messages, threads, indexes, embedding state and attachment blobs. |
| `mail-promoter/` | Mail promotion state and note tracking. |
| `action-center/actions.db` | Action items, seen ledger and scan metadata. |
| `steward/calendar-index.sqlitedb` | Calendar search index. |
| `steward/contacts-index.sqlitedb` | Contacts search index. |
| `write-ops/ops.db` | Journal for AppleScript writes and confirmation/retry status. |
| `steward-chats/chats.db` | Chat list and transcripts. |
| `steward-chats/` session files | Per-chat agent session state. |
| `steward-usage/usage.db` | Token/cost/tool usage ledger. |
| `steward-uploads/` | Files uploaded through the web UI. |

Read sources include:

- `~/Library/Mail` for Apple Mail `.emlx` files;
- `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`;
- `~/Library/Application Support/AddressBook`;
- the chosen LLM Wiki project directory;
- user-selected local files/folders.

On macOS these require the right privacy permissions. The process running Steward needs Full Disk Access for local data reads. AppleScript writes require Automation permission for Mail, Calendar and Contacts.

## Background Jobs

`apps/scheduler` is a thin orchestrator that shells out to existing app CLIs.

| Job | Default interval | What it does |
|---|---:|---|
| `mail-reconcile` | 10 min | Ingest new/changed/deleted Apple Mail `.emlx` files into the mirror. |
| `write-ops-mail` | 10 min | Confirm and safely retry mail writes against the mail mirror. |
| `write-ops-send-due` | 2 min | Send scheduled emails whose time has arrived. |
| `mail-embed` | 15 min | Embed mirrored mail that does not yet have vectors. |
| `mail-distill` | 15 min | Run mail-promoter to triage and distill new threads into wiki notes. |
| `calendar-sync` | 10 min | Rebuild/update the calendar search index. |
| `write-ops-calendar` | 10 min | Confirm calendar writes against the index. |
| `action-center` | 10 min | Scan mail into Action Center items with proposed steps. |

Intervals are controlled by `SCHED_*_MIN` environment variables. Scheduler logs default to `~/Library/Logs/Steward/scheduler.jsonl` in the packaged flow.

## Security Model

Steward is designed so trust is structural, not based on the model behaving perfectly.

- **Default-deny tools** — [apps/host/src/core/tool-policy.ts](apps/host/src/core/tool-policy.ts) classifies tool calls. Read-only tools are allow-listed. Sensitive writes are gated. Unknown or disallowed tools are denied.
- **Human approval for writes** — the agent can request an action, but the host turns it into an approval card before execution.
- **Write journal** — AppleScript writes are recorded before they run and confirmed afterwards against local mirrors.
- **No raw shell** — shell-like commands are parsed and executed with explicit binaries/argv. Dangerous shell features are rejected.
- **Sensitive path blocking** — path guards protect secrets such as `.env`, SSH keys and other private locations.
- **Token-gated data routes** — data HTTP routes and WebSocket connections require the host auth token.
- **Local-first services** — host/gateway default to local listeners. Mobile access is opt-in.
- **Opaque file serving** — files are exposed to the UI through registered tokens, not arbitrary open paths.
- **Provider isolation** — model keys live behind the gateway. The host talks to the gateway, not directly to every provider.

## Setup

### Prerequisites

- macOS.
- Node.js 20 or newer.
- npm.
- Xcode Command Line Tools for the Swift launcher/package flow.
- Ollama with required local models:

```sh
ollama pull bge-m3
ollama pull llama3.2:1b
```

- A DeepSeek API key for paid tiers, placed in `apps/llm-gateway/.env` using [apps/llm-gateway/.env.example](apps/llm-gateway/.env.example).
- Full Disk Access for the terminal, launcher or packaged app running Steward.
- Automation permissions when macOS prompts for Mail/Calendar/Contacts writes.

### Development Run

```sh
npm install

# Start the model gateway.
npm run dev -w @steward/llm-gateway

# Start the LLM Wiki desktop app separately.
# Its MCP server talks to the local LLM Wiki API.

# Start the host.
npm run dev -w @steward/host

# Start the web UI.
npm run dev -w @steward/web
```

Then open:

```text
http://localhost:5173
```

One-time mail bootstrap:

```sh
node --import tsx apps/mail-mirror/src/cli.ts backfill
node --import tsx apps/mail-mirror/src/cli.ts migrate
```

Background scheduler:

```sh
npm run start -w @steward/scheduler
```

### Host-Served Web UI

Build the web UI and let the host serve it from `http://127.0.0.1:4317`:

```sh
npm run build -w @steward/web
npm run dev -w @steward/host
```

### macOS Launcher

Run the native menu-bar launcher:

```sh
npm run launcher:mac
```

The launcher:

- opens the Steward web UI in a WebKit window;
- lives in the menu bar;
- registers `Command+Shift+Space`;
- starts Ollama when possible;
- checks for `bge-m3`;
- starts the gateway and host if needed;
- uses Vite during development when no built web UI exists.

### Packaged App

Build a self-contained local app bundle:

```sh
npm run package:mac
open "dist/mac/Steward.app"
```

The bundle includes:

- Swift launcher;
- built web UI;
- compiled service entrypoints;
- Node runtime;
- required native dependencies such as `better-sqlite3` and `sqlite-vec`;
- bundled speech runtime files when present.

Production overrides and secrets go in:

```text
~/Library/Application Support/Steward/config.env
```

Logs go in:

```text
~/Library/Logs/Steward/
```

## Important Environment Variables

| Variable | Purpose |
|---|---|
| `HOST_PORT` | Host port, default `4317`. |
| `HOST_ALLOWED_ORIGINS` | Extra allowed browser origins. Same-origin host requests are accepted automatically. |
| `STEWARD_AUTH_TOKEN` | Override persisted auth token. |
| `STEWARD_TLS_CERT` / `STEWARD_TLS_KEY` | Enable optional HTTPS listener for phone/Tailscale access. |
| `STEWARD_TLS_PORT` | HTTPS listener port, default `HOST_PORT + 1`. |
| `GATEWAY_BASE_URL` | Host-to-gateway base URL, default `http://127.0.0.1:4000/v1`. |
| `HOST_TIER` | Agent model tier, default `tier-5`. |
| `GATEWAY_API_KEY` | Local gateway API key expected by clients, default `sk-local`. |
| `DEEPSEEK_API_KEY` | Gateway provider key for paid tiers. |
| `GATEWAY_PORT` | Gateway port, default `4000`. |
| `GATEWAY_REQUEST_TIMEOUT_MS` | Gateway request timeout. |
| `MAIL_EMBED_ENDPOINT` | Mail embedding endpoint; defaults to gateway, set `off` to disable. |
| `MAIL_CLASSIFY_ENDPOINT` | Mail role classification endpoint; defaults to gateway, set `off` to disable. |
| `MAIL_PROMOTER_LLM_ENDPOINT` | Mail-promoter LLM endpoint; defaults to gateway. |
| `APPROVAL_TIMEOUT_MS` | Approval timeout for gated actions. |
| `STEWARD_PUSH_CONTACT` | VAPID contact URI for Web Push. |
| `STEWARD_WHISPER_BIN` | Path to `whisper.cpp` binary for transcription. |
| `STEWARD_WHISPER_MODEL` | Path to local Whisper model file. |
| `STEWARD_SPEECH_LANGUAGE` | Speech language, default `it`. |
| `STEWARD_SPEECH_ENABLED` | Set `0` to disable transcription. |
| `SCHED_*_MIN` | Override scheduler intervals. |
| `LLM_WIKI_BUNDLED_SERVICES` / `STEWARD_BUNDLED_SERVICES` | Tell services they are running from the packaged bundle. |

## Development Notes

- Workspaces use TypeScript ESM.
- Most CLIs run with `node --import tsx`.
- Tests use Node's built-in test runner or Vitest depending on the app.
- Run a workspace test with `npm test -w @steward/<workspace>`.
- Run a workspace typecheck with `npm run typecheck -w @steward/<workspace>`.
- `npm run build:web-host` builds the web UI and typechecks the host.
- The LLM Wiki fork has its own Vite/Tauri/Vitest toolchain under [apps/llm-wiki](apps/llm-wiki/).

Useful workspace names include:

- `@steward/web`
- `@steward/host`
- `@steward/llm-gateway`
- `@steward/mail-mirror`
- `@steward/mail-mcp`
- `@steward/mail-promoter`
- `@steward/action-center`
- `@steward/calendar-mcp`
- `@steward/contacts-mcp`
- `@steward/shell-mcp`
- `@steward/scheduler`
- `@steward/wiki-add`
- `@steward/llm-wiki`

## Project Direction

The repo is structured as a platform, not a single-purpose mail assistant.

The host speaks a small channel protocol. Tools are MCP servers. Models are hidden behind capability tiers. The approval system is independent of the model. This means new capabilities can be added as additional connectors or clients:

- more channels such as Telegram, Discord or native mobile clients;
- more local or cloud connectors;
- browser automation;
- richer action policies and allowlists;
- long-running workflows and follow-ups;
- deeper structured memory over the wiki and local indexes;
- fuller audit trails for actions, reads and decisions.

The core idea stays the same: keep private context local, keep memory inspectable, make useful actions easy, and require explicit approval for anything that changes the outside world.
