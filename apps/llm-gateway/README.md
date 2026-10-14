# LLM Gateway

The default OpenAI-compatible endpoint for Steward services. The public namespace is a
vendor-agnostic **capability ladder** selected via `model`: `tier-1` (weak local)
… `tier-6` (strongest paid), plus `local-embed` for embeddings. Callers pick a
tier number; the real models live only in the gateway adapter.

This gateway is a small self-contained TypeScript server (`src/gateway.ts`, no
external gateway process). It binds to `127.0.0.1`, not all interfaces, and routes each request **directly** to the provider's
own OpenAI-compatible endpoint (DeepSeek / Ollama), which preserves tool-calling
and the provider's `usage` block verbatim. The app uses `http://127.0.0.1:4000/v1`.

> Previously this sat in front of Portkey; Portkey's provider transform dropped
> `tools`/`tool_choice`, so we route direct instead.

Today tiers 2–5 map to **DeepSeek V4 Flash** (the reliable cheap workhorse) and
tier-6 to **DeepSeek V4 Pro**; tier-1 is local Ollama. On non-streaming failure,
a tier escalates up then sweeps the lower paid rungs before returning an error.
Streaming requests can also fall back before output is committed, including a
non-streaming retry re-emitted as synthetic SSE. Once bytes reach the client, the
gateway cannot switch targets mid-response.

## Run

1. Ollama running locally with the models pulled (`ollama pull bge-m3`, `ollama pull llama3.2:1b`).
2. Copy `.env.example` to `.env`, set `DEEPSEEK_API_KEY` (tiers 2–6).
3. Start the gateway: `npm run dev -w @steward/llm-gateway`

Gateway base URL: `http://127.0.0.1:4000` (`/v1/chat/completions`, `/v1/embeddings`).
Optional env: `GATEWAY_PORT`, `GATEWAY_REQUEST_TIMEOUT_MS`, `DEEPSEEK_BASE_URL`.

## Centralized wiring

Steward services point at this gateway by default — including the host, which runs Pi
(`@earendil-works/pi-coding-agent`) against `tier-5` here. The old
Agent-SDK/Claude-subscription path is retired (see below).

**Default-on (no endpoint env needed).** mail-mirror and mail-mcp default their
embedding + role-classify endpoints to the gateway; mail-promoter already
defaults its classify/distill calls here. Provider availability and local model installation remain prerequisites.

- mail-mirror / mail-mcp embeddings → `http://127.0.0.1:4000/v1/embeddings`
  (model `local-embed`). Override with `MAIL_EMBED_ENDPOINT` / `MAIL_EMBED_MODEL`;
  disable with `MAIL_EMBED_ENDPOINT=off`.
- mail-mirror role-classify → `http://127.0.0.1:4000/v1/chat/completions`
  (model `tier-2`). Override with `MAIL_CLASSIFY_ENDPOINT` / `MAIL_CLASSIFY_MODEL`;
  disable with `MAIL_CLASSIFY_ENDPOINT=off`.
- mail-promoter → `MAIL_PROMOTER_LLM_ENDPOINT` (default `http://127.0.0.1:4000/v1/chat/completions`; a full endpoint, not a base URL),
  triage=`tier-5` (one call does classify + distil; see mail-promoter `triage.ts`).

> Heads-up: because embeddings default-on, `mail-mirror watch` / `mail-mirror embed`
> now embed the backlog through the gateway when run. Set `MAIL_EMBED_ENDPOINT=off`
> to keep them disabled.

**llm-wiki (manual, one-time).** llm-wiki reads its provider from app config,
not env, so it can't be wired in code here. In the llm-wiki UI add a custom
OpenAI-compatible provider with base URL `http://127.0.0.1:4000/v1` and select
`local-embed` for embeddings (and a chat model from the tiers above as needed).

## Resilience (api tier)

The gateway keeps the tier aliases (`tier-*`, `local-embed`) and performs
sequential fallback across tiers (escalate, then sweep the lower paid rungs) for
both streaming and non-streaming calls, with one shared upstream request/body deadline
(`GATEWAY_REQUEST_TIMEOUT_MS`). For streaming, this fallback happens before the
first byte is written to the client (native stream, then a non-streaming retry
re-emitted as synthetic SSE, per target); once bytes have started flowing for a
given attempt, that stream cannot be retried mid-flight.

## Claude-subscription tier (retired, optional)

The default capability tiers use the DeepSeek API rather than the Claude
subscription. The Agent-SDK adapter (`src/adapter.ts`) that bridged Claude on the
subscription is kept for reference: to put a subscription rung back, start it in a
process WITHOUT `ANTHROPIC_API_KEY` (so it uses the subscription, not the API) and
explicitly extend `models` and `directOpenAIBaseUrl()` in `src/gateway.ts` to route
a selected alias to `http://127.0.0.1:4001/v1`. There is no `api_base` configuration
field or environment toggle that activates it in the current gateway:

    cd apps/llm-gateway
    env -u ANTHROPIC_API_KEY node --import tsx src/adapter.ts   # listens on :4001

It exposes `claude-haiku-sub` / `claude-sonnet-sub` / `claude-opus-sub`; the
adapter refuses to start if `ANTHROPIC_API_KEY` is set. It is not started by the
ordinary launcher/deployment. Its standalone server explicitly binds loopback, but remains a retired optional
adapter with its own authentication behavior; do not expose it as a public API.

## Smoke test (live)

From the monorepo root with the gateway running:

    node --import tsx apps/llm-gateway/scripts/smoke.mts

Checks a `local-embed` embeddings call and a chat tier (JSON round-trip via
`extractJson`). Exits non-zero on failure.

## Authentication, accounting and configuration limits

When `GATEWAY_API_KEY` is explicitly set on the gateway, model POST routes
require the matching Bearer key (timing-safe comparison). Missing/wrong credentials
return 401 before provider execution. Unset preserves unauthenticated loopback
compatibility. `/health`, `/models` and `/rates` remain public diagnostics; host
pairing tokens are separate. Set the same key in callers and the wiki custom
provider UI. Shared Steward credential resolution only reuses that key for the
exact configured loopback gateway `/v1` endpoint; remote endpoint overrides need
their own service-specific key and do not receive the shared secret automatically.

Models, fallback order and `/rates` are code tables, not live prices. Repeated
aliases for the same provider/model/host/key collapse to one target. HTTP 429/5xx
and transport failures permit fallback; ordinary deterministic 4xx return directly.
`tier-1` and `local-embed` have no paid fallback. `GATEWAY_REQUEST_TIMEOUT_MS`
defaults to 120 seconds shared across targets and body/stream consumption. Native
stream then synthetic nonstream fallback can make two distinct attempts to one
target, but fallback stops after output headers are committed; interrupted visible
streams terminate instead of being replaced.

`x-usage-service`, `x-usage-action` and optional `x-usage-session` label calls;
missing labels become `unknown`. One terminal ledger entry contributes tokens and
estimated cost. Separate `provider_attempts` rows correlate request ID, model,
HTTP status (zero for pre-response failure), stream mode and time to headers;
summary diagnostics expose the latest 100. These rows do not duplicate terminal
billing and do not measure body completion or unknown upstream charges. Metering
remains best-effort. Missing usage does not prove a free call. Wiki direct providers
and endpoint overrides can bypass gateway accounting.

For deterministic verification:

```sh
npm test -w @steward/llm-gateway
```

The live smoke above contacts the configured models and writes normal Usage
records. It is separate from unit tests.
