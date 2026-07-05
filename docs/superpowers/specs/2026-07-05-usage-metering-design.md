# Usage metering — gateway-side LLM cost ledger + Usage page redesign

**Date:** 2026-07-05
**Status:** Approved (brainstormed with user; storia legacy: azzerata)

## Problem

The Usage page (`apps/web/src/components/usage-page.tsx`) shows cost/token
analytics, but only the host agent's chat turns are metered (host writes the
`turns` table in `usage.db`). Every other LLM consumer spends tokens invisibly:

- **mail-promoter** (triage + distill cascade) — discards the `usage` field
- **action-center** (LLM scans) — same
- **mail-mirror** (role-classify) — same
- **scheduler** — runs the above CLIs
- **embeddings** (`local-embed`, bge-m3 via Ollama) — $0 but volume uncounted
  (mail-mcp, calendar-mcp, contacts-mcp, wiki search)
- **llm-wiki** (Tauri) — configured in settings to point at the gateway
- The **gateway** itself logs nothing; it passes `usage` through to clients

Goal: the Usage page becomes the complete observability view — every action
the software performed, with per-piece (per service, per action, per call)
and total costs.

## Decisions (from brainstorming)

- **Scope:** everything flowing through the gateway, including the llm-wiki
  Tauri app (it targets the gateway via its settings). Direct third-party
  endpoints (wiki configured against Azure/OpenAI directly) are out of scope —
  we meter the choke point.
- **Granularity:** service + action + individual call, with drill-down.
- **Observability only:** no budgets, no alerts, no enforcement (can be layered
  on the same ledger later).
- **Architecture:** metering in the gateway (approach A). Rejected: per-client
  shared wrapper package (easy to forget — exactly how today's gap formed);
  event POSTs to the host (single-writer purity not worth the fragility).
- **Legacy history:** the old `turns` table is retired — the page reads only
  `llm_calls` and starts from zero with fully labeled data. `turns` is no
  longer written nor displayed (the table itself may remain on disk; it is
  simply ignored).

## Architecture

### 1. Ledger: new `llm_calls` table in `usage.db`

Written by the **gateway** on every `/v1/chat/completions` and `/v1/embeddings`
response (successful or failed):

| column | content |
|---|---|
| `id` | integer PK |
| `ts` | timestamp ms |
| `service` | from `x-usage-service` header, else `unknown` |
| `action` | from `x-usage-action` header, else `unknown` |
| `session_id` | from `x-usage-session` header (nullable; groups calls of one chat/turn) |
| `tier` | requested gateway tier (e.g. `tier-5`) |
| `model` | actual model served (after fallback) |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | from the provider's `usage` field (embeddings: input only) |
| `cost_usd` | computed by the gateway from its `rates` map (existing single source of truth, per tier); local embeddings = 0 but volume recorded |
| `duration_ms` | request latency |
| `ok` | 0/1 outcome |
| `status` | HTTP status from the provider |

Index on `ts`. Failed calls are recorded with tokens 0 and `ok = 0`.

The gateway opens the same `usage.db` the host uses (path logic shared /
duplicated from `UsageStore.open()`: `USAGE_DIR` env or
`~/Library/Application Support/steward-usage/usage.db`). Gateway writes,
host reads: WAL mode + `busy_timeout` (multi-process better-sqlite3, pattern
already in use).

### 2. Double counting eliminated

A chat turn *is made of* LLM calls that traverse the gateway. The host
therefore **stops writing the `turns` table** (`agent-runner.ts` turn
recording removed). The turn identity survives as labels on the calls:
service `host`, action `agent-turn`, `x-usage-session` = chat id.

`tool_calls` is unchanged — still written by the host (only it sees tools),
still costless (counts + durations).

### 3. Attribution headers

Canonical header names and service/action values live in a shared module in
`packages/protocol`. Calls without headers are recorded as `unknown/unknown`:
spend is never lost, and an "unknown" row in the UI is the signal that a
caller needs labeling.

| Service | Where the header is added | Labels |
|---|---|---|
| host (agent) | `apps/host/src/core/pi-provider.ts` (headers on the Pi provider config) | `host` / `agent-turn` + session id |
| mail-promoter | `apps/mail-promoter/src/llm.ts` (`gatewayChat`) | `mail-promoter` / `triage` \| `distill` |
| action-center | `apps/action-center/src/llm.ts` (`gatewayChat`) | `action-center` / `scan` |
| mail-mirror | `apps/mail-mirror/src/role-classify.ts` | `mail-mirror` / `role-classify` |
| embeddings | `packages/embedding` + `packages/search` (consumer passes its own name) | `mail-mcp` \| `calendar-mcp` \| `contacts-mcp` \| `llm-wiki` / `embed` |
| llm-wiki (Tauri) | its LLM client — **only when the configured endpoint is the gateway** | `llm-wiki` / `chat` (or specific: `ingest`, `distill`, …) |

Notes:
- The wiki never sends these headers to third-party endpoints (no foreign
  headers to external APIs). Detection: headers are attached only when the
  configured endpoint's origin matches the gateway origin (the local gateway
  URL, default `http://127.0.0.1:4000`). If the wiki is pointed at a direct
  provider, those calls bypass the gateway and are simply absent — consistent
  with metering the choke point.
- The scheduler does not appear: it launches the services' CLIs, which label
  themselves.

### 4. Streaming

The gateway currently pipes streaming responses verbatim. It will request the
final `usage` block (`stream_options.include_usage`) from the provider while
leaving the client-visible stream untouched, and record tokens from that
final chunk. If the provider sends no usage block, the row is recorded with
tokens 0 (the call still counts toward action totals; `ok` reflects the real
outcome).

### 5. `/usage` API (host)

The host's `/usage` endpoint remains the only API the web UI reads, now
aggregating from `llm_calls` (+ `tool_calls`). Accepts `?days=7|30|all`
(default 30). Response:

- `totals` — cost, calls, tokens by kind (input/output/cacheRead/cacheWrite)
- `byService` — cost, calls, tokens per service
- `byAction` — rows `service+action` with cost, calls, tokens, **avg cost per
  call** (the per-piece price: one triage, one distill, one agent turn…)
- `byDay` — per-day cost **split by service** (last N days)
- `byModel` — per model/tier, as today
- `recent` — last 100 calls: ts, service, action, model, tokens, cost,
  duration, ok
- `byTool` / `toolTotals` — unchanged
- `costByKind` — USD cost per token kind, computed server-side per tier
  (each tier's tokens × that tier's rates); replaces the old flat `rates`
  field, which cannot price the split correctly across multiple tiers

### 6. Usage page (web UI)

Same stack (shadcn + hand-rolled SVG, no charting dependency). Top-to-bottom:

1. **Period selector** (7 days / 30 days / all) — drives the whole page
2. **Summary cards**: total cost, cost today, total calls, total tokens
3. **Cost by service** — the headline new view: proportional bars with cost,
   calls, tokens per service; an `unknown` row is highlighted as a warning
   ("there's an unlabeled caller")
4. **Cost by action** — table `service · action · calls · total cost · avg
   cost/piece`, sorted by spend
5. **Cost by day** — daily bars stacked by service (stable per-service colors)
6. **Cost by model** — as today
7. **Tools** — table unchanged
8. **Recent calls** — replaces "Recent turns": when, service, action, model,
   tokens in/out, cost, duration, outcome (failures in red)

## Error handling

- **Metering must never break an LLM call**: gateway ledger writes are
  best-effort (try/catch, log, continue) — same stance the host takes today.
- Failed provider calls are recorded (outcome + status, tokens 0) so failed
  attempts are visible.
- Two processes on one SQLite file: WAL + `busy_timeout`.

## Testing

- **Gateway unit tests**: recording with a mocked provider; cost computation
  from `rates`; missing headers → `unknown`; streaming with and without a
  final usage block; ledger write failure does not fail the request.
- **Host unit tests**: `/usage` aggregations over a seeded `llm_calls` table
  (per-service, per-action avg cost, per-day-per-service, period filter).
- **E2E smoke**: call through the gateway → row lands in ledger → `/usage`
  exposes it. Follow existing test patterns in both services.

## Out of scope

- Budgets, alerts, enforcement (future layer on the same ledger).
- Metering wiki calls to direct third-party providers.
- Backfilling service/action labels onto historical `turns` data (history is
  reset by decision).
