# LLM Wiki — personal agent monorepo

A **local-first personal agent for macOS**. It reads and acts on your real data — Apple Mail, Calendar, Contacts, files on disk — through a gated tool system, uses a personal wiki as long-term memory, and routes every LLM call through a self-hosted gateway so models are swappable and costs are visible. Everything runs on your machine; the only network egress is the LLM provider behind the gateway.

> The wiki app itself (`apps/llm-wiki`) is a vendored fork of the LLM Wiki desktop app; everything else in this repo is original.

## What it does

**Chat with an assistant that actually knows your life and can act on it.** In the web UI you can ask things like:

- *"Find the invoice PDF the accountant sent me last month and forward it to Marco"* — the agent searches the mail mirror (keyword + semantic), saves the attachment, resolves "Marco" through your contacts, drafts the email, and shows you an **approval card** with the exact payload. Nothing is sent until you approve (you can also edit the draft inline, or reply with a revision note).
- *"Am I free Thursday afternoon? If so, accept Anna's meeting proposal"* — it cross-checks Calendar, replies to the thread, and creates the event, each write gated by your approval.
- *"What did I decide about the solar-panel certification?"* — it answers from the wiki, where the mail-distillation pipeline has already filed the durable facts from that email thread, with a `message://` backlink to the original.
- *"Take the newest PDF in Downloads and archive it in Documents/contracts"* — file search and shell operations work the same way: reads are free, mutations need your OK.

**It works for you in the background, not just when you ask.** The scheduler continuously:

- mirrors your Apple Mail into a local SQLite store and embeds it, so search is instant and semantic — including attachments;
- **distills durable knowledge from new mail into the wiki** (commitments, documents, decisions, personal facts — noise like marketing is filtered), building a personal memory that compounds over time;
- scans new mail for things that need you and fills the **Action Center**: a reply-needed thread or a scheduling request shows up as a card with LLM-prepared, ready-to-execute proposals ("accept and create the event", "decline and propose Friday") — one click, one approval, done;
- **confirms every write actually happened** (did that email really send?) by checking the mirrors afterwards, and retries safely if not — including emails you scheduled to send later.

**Why it's different from a chatbot with plugins:**

- *Your data never leaves the machine* except as LLM prompts to the provider you chose — and the capability-tier gateway means that provider is swappable in one place (today: DeepSeek for reasoning, local Ollama for embeddings; tomorrow: whatever wins on price/quality).
- *Trust is structural, not behavioral*: the model can only request tools; a deterministic default-deny policy decides what runs, what asks you first, and what is refused. A hallucinated "send" cannot fire.
- *Memory is yours and inspectable*: it's a wiki of markdown pages you can read, edit, and search — not an opaque vector blob.
- *Every euro is visible*: a per-turn usage ledger tracks tokens, cost, and per-tool latency/errors in the Usage page.

## Where it's going

The architecture is deliberately a **platform**, not a mail feature: channels speak a small event protocol to the host, tools are MCP servers, models sit behind capability tiers. The roadmap builds on that:

- **More connectors**: iMessage, WhatsApp/Telegram, browser automation (apply on portals, fill forms), cloud drives — each one is just another MCP server behind the same approval gate.
- **More channels**: the web UI is one client of the protocol; Telegram/Discord/mobile push are thin additional clients — approve an action from your phone.
- **Durable workflows**: event-triggered runs ("new mail wakes the agent") and stateful follow-ups ("if no reply in 7 days, nudge me"), on top of the existing scheduler + write-ops state machine.
- **Living structured memory**: open-commitment tracking ("the accountant asked for X a week ago — still open"), temporal queries ("what changed since May"), style learning from the edits you make to drafts before approving.
- **Policy & audit**: per-recipient allowlists, autonomy levels per tool ("file documents autonomously, always ask before replying"), and a full audit trail of what the agent read, decided, and did.

## How it fits together

```
                    ┌────────────────────── browser ──────────────────────┐
                    │  apps/web (React UI: chat, approvals, action center) │
                    └───────────────▲──────────────────────────────────────┘
                                    │ WebSocket + HTTP  (packages/protocol)
┌───────────────┐   ┌───────────────┴───────────────┐
│ apps/mac-     │──▶│ apps/host  :4317               │   Pi agent engine, one session per chat
│ launcher      │   │  · tool policy (default-deny)  │   · gated writes → approval cards in UI
│ (menu bar,    │   │  · chat store / usage ledger   │   · file registry (token-gated serving)
│  health checks│   │  · action-center executor      │
└───────────────┘   └───────┬───────────────▲────────┘
                            │ MCP (stdio,   │ OpenAI-compatible
                            │ mcp-bridge)   │ chat/completions
        ┌───────────────────┴──────┐  ┌─────┴──────────────────┐
        │ MCP connectors           │  │ apps/llm-gateway :4000 │
        │ · llm-wiki (fork's MCP)  │  │  tier-1…6 + local-embed│
        │ · mail  · calendar       │  │  DeepSeek / Ollama     │
        │ · contacts · shell       │  └────────────────────────┘
        │ · action-center          │
        └──────────▲───────────────┘
                   │ SQLite reads / AppleScript writes
┌──────────────────┴──────────────────────────────────────────┐
│ apps/scheduler (launchd daemon) — every N minutes:          │
│  mail-mirror reconcile/embed → mail-promoter distill →      │
│  calendar sync → write-ops confirm/retry → action-center scan│
└──────────────────────────────────────────────────────────────┘
```

Three planes:

1. **Interactive** — you chat in the web UI; the host runs a Pi agent whose only tools are the MCP connectors, each call classified `allow` (read-only) / `gate` (needs your approval card) / `deny` by [tool-policy](apps/host/src/core/tool-policy.ts).
2. **Background** — the scheduler keeps local SQLite mirrors of Mail/Calendar fresh, embeds them for semantic search, distills durable knowledge into the wiki, and builds the Action Center (reply-needed mail, scheduling requests) with LLM-proposed, pre-filled actions you approve with one click.
3. **Reliability** — every AppleScript *write* (send mail, create event) is journaled in `packages/write-ops` and later **confirmed against the mirrors**; unconfirmed writes are retried safely.

## Components

| Path | What it is |
|---|---|
| [apps/host](apps/host/) | Agent host: WebSocket server (`:4317`), Pi sessions per chat, permission gate, chat/usage SQLite stores, file registry, action executor |
| [apps/web](apps/web/) | React + Vite UI: multi-chat, streaming, tool cards, approval/question cards, file chips & uploads, Action Center, Usage and System pages |
| [packages/protocol](packages/protocol/) | The dependency-free event contract between host and any channel client (web today; Telegram/Discord later) |
| [packages/mcp-bridge](packages/mcp-bridge/) | Bridges stdio MCP servers into Pi custom tools (`mcp__<server>__<tool>`) |
| [apps/llm-gateway](apps/llm-gateway/) | Self-contained OpenAI-compatible gateway (`:4000`). Capability ladder `tier-1` (local Ollama) … `tier-6` (strongest paid), `local-embed` for embeddings; tier fallback on failure |
| [apps/llm-wiki](apps/llm-wiki/) | The wiki desktop app (vendored fork) + its MCP server — the agent's long-term memory |
| [apps/mail-mirror](apps/mail-mirror/) | SQLite mirror of Apple Mail's `.emlx` store: backfill/reconcile, thread resolution, trigram + vector indexes, attachment blobs |
| [apps/mail-mcp](apps/mail-mcp/) | Mail connector: search (hybrid keyword/semantic + advanced filters), read, thread, attachments; send/reply/scheduled-send via AppleScript, journaled in write-ops |
| [apps/mail-promoter](apps/mail-promoter/) | Mail → wiki pipeline: per-thread triage+distill in one LLM call; promotes durable knowledge (and selected attachments) as wiki sources with `message://` backlinks |
| [apps/calendar-mcp](apps/calendar-mcp/) | Calendar connector: reads Apple's `Calendar.sqlitedb`, hybrid-search index, AppleScript create/update/delete |
| [apps/contacts-mcp](apps/contacts-mcp/) | Contacts connector: multi-source AddressBook read, dedup, hybrid search, `resolve_recipient`, AppleScript writes |
| [apps/shell-mcp](apps/shell-mcp/) | Limited safe shell: Spotlight `find_files`, read-only `run_command` with real pipe syntax but **no shell spawned** (own parser + execFile allowlist), gated `run_write_command` |
| [apps/action-center](apps/action-center/) | Scans new mail (seen-ledger) with an LLM planner → actionable items with executable proposed steps; exposed as an MCP + consumed by host/web |
| [apps/scheduler](apps/scheduler/) | The single background daemon (launchd): interval jobs, no-overlap, error isolation; every job shells out to an app CLI |
| [packages/write-ops](packages/write-ops/) | Journal + confirm/retry state machine for AppleScript writes (mail send/reply incl. send-later, calendar CRUD) |
| [packages/embedding](packages/embedding/), [packages/search](packages/search/) | Shared embedding client (batching, retry) and hybrid-search primitives (RRF, sqlite-vec `VectorStore`) |
| [packages/applescript](packages/applescript/) | Shared `osascript` runner: escaping, timeouts, transient-error retry |
| [apps/wiki-add](apps/wiki-add/) | CLI + Finder Quick Actions: add files/folders to the wiki (snapshot into `raw/sources/`, dedup manifest, rescan trigger) |
| [apps/mac-launcher](apps/mac-launcher/) | SwiftPM menu-bar app: WebKit window, global shortcut (⌘⇧Space), health-checks and auto-starts Ollama/gateway/host; `npm run package:mac` builds a self-contained `.app` |

## Ports & endpoints

| Port | Service |
|---|---|
| `4317` | Host — WebSocket protocol + HTTP (`/health`, `/upload`, `/usage`, `/file/<token>`, `/resolve`, `/system/*`, serves `apps/web/dist`) |
| `4000` | LLM gateway — `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`, `/health` |
| `11434` | Ollama (tier-1 chat + `bge-m3` embeddings) |
| `5173` | Vite dev server (web UI development) |

## Data on disk (all under `~/Library/Application Support/`)

| Location | Contents |
|---|---|
| `mail-mirror/mail.db` + `blobs/` | Mail mirror (messages, threads, trigram+vector indexes, attachment blobs) |
| `mail-promoter/` | Promotion state (which threads were distilled, note filenames) |
| `action-center/actions.db` | Action items, seen-ledger, scan metadata |
| `llm-wiki/calendar-index.sqlitedb`, `llm-wiki/contacts-index.sqlitedb` | Hybrid-search indexes for calendar/contacts |
| `write-ops/ops.db` | AppleScript write journal (statuses: started → script_returned → confirmed / retrying …) |
| `llmwiki-chats/` | Chat transcripts (`chats.db`) + Pi session files (agent memory per chat) |
| `llmwiki-usage/usage.db` | Per-turn token/cost ledger + per-tool call stats |
| `llmwiki-uploads/` | Files you attach in the UI |

Read sources: Apple Mail `~/Library/Mail` (.emlx), `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`, `~/Library/Application Support/AddressBook`. These require **Full Disk Access**; AppleScript writes require **Automation** permission for Mail/Calendar/Contacts.

## Setup

Prerequisites: Node ≥ 20, npm, Xcode CLT (launcher), [Ollama](https://ollama.com) with `ollama pull bge-m3` (and `llama3.2:1b` for tier-1), a DeepSeek API key.

```sh
npm install

# 1. Gateway (put DEEPSEEK_API_KEY in apps/llm-gateway/.env — see .env.example)
npm run dev -w @llm-wiki/llm-gateway

# 2. The LLM Wiki desktop app must be running (its MCP server talks to the local API)

# 3. Host + web UI (dev)
npm run dev -w @llm-wiki/host
npm run dev -w @llm-wiki/web        # → http://localhost:5173

# One-time data bootstrap
node --import tsx apps/mail-mirror/src/cli.ts backfill   # mirror your mailboxes
node --import tsx apps/mail-mirror/src/cli.ts migrate    # enrich (advanced search)

# Background daemon (or let the packaged app / launchd manage it)
npm run start -w @llm-wiki/scheduler
```

macOS launcher (menu-bar app with health checks): `npm run build -w @llm-wiki/web && npm run launcher:mac`.
Self-contained production bundle: `npm run package:mac` → `dist/mac/LLM Wiki.app` (bundles node, esbuilt entrypoints for every service, the wiki app, and native modules).

## Background jobs (scheduler)

| Job | Default interval | What it does |
|---|---|---|
| `mail-reconcile` | 10 min | Ingest new/changed `.emlx` into the mirror; soft-delete removed mail |
| `write-ops-mail` | 10 min | Confirm sent mail against the mirror; safe retry of unconfirmed sends |
| `write-ops-send-due` | 2 min | Fire scheduled (send-later) emails whose time has come |
| `mail-embed` | 15 min | Embed not-yet-embedded mail (via gateway `local-embed`) |
| `mail-distill` | 15 min | mail-promoter: triage+distill new threads into wiki notes |
| `calendar-sync` | 10 min | Rebuild the calendar hybrid-search index |
| `write-ops-calendar` | 10 min | Confirm calendar writes against the index |
| `action-center` | 10 min | Scan new mail into actionable items with proposed steps |

Intervals are overridable via `SCHED_*_MIN` env vars; logs at `/tmp/llmwiki-scheduler.jsonl`.

## Security model

- **Default-deny tool policy** ([tool-policy.ts](apps/host/src/core/tool-policy.ts)): read-only tools are allow-listed; anything side-effecting (send mail, create event, write files) raises an **approval card** in the UI — with approve / approve-with-edits / deny-with-note / request-revision. The decision is deterministic code, independent of model output.
- **No shell, ever**: the shell connector parses command lines itself and spawns allow-listed binaries with explicit argv; `;`, `>`, `$()`, backticks are rejected. Sensitive paths (`~/.ssh`, `.env`, keychains, …) are blocked at multiple layers.
- **Write journal**: every AppleScript write is recorded before execution and later confirmed against local mirrors, so "did it actually send?" has an auditable answer.
- **Local-only listeners**: host and gateway bind `127.0.0.1`. Files are served only through opaque per-file tokens.
- LLM traffic goes only to the providers configured in the gateway (DeepSeek / local Ollama); the host itself holds no provider keys.

## Development

- Per-workspace: `npm run typecheck -w @llm-wiki/<app>` and `npm test -w @llm-wiki/<app>` (Node's built-in test runner via tsx; no build step).
- Web UI: `npm run build:web-host` builds web and typechecks the host together.
- The wiki fork has its own toolchain (`vitest`, `vite`, Tauri) — see [apps/llm-wiki](apps/llm-wiki/).
- Conventions: TypeScript ESM everywhere, `type: module`, tsx for execution, better-sqlite3 + sqlite-vec for storage/search, reuse over reimplement (shared code goes in `packages/`).
- Current fix backlog: [docs/superpowers/plans/2026-07-03-review-fixes.md](docs/superpowers/plans/2026-07-03-review-fixes.md).
