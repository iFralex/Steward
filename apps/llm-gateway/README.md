# LLM Gateway

One OpenAI-compatible endpoint for every service. The public namespace is a
vendor-agnostic **capability ladder** selected via `model`: `tier-1` (weak local)
… `tier-6` (strongest paid), plus `local-embed` for embeddings. Callers pick a
tier number; the real models live only in the gateway adapter.

This gateway is a small self-contained TypeScript server (`src/gateway.ts`, no
external gateway process). It routes each request **directly** to the provider's
own OpenAI-compatible endpoint (DeepSeek / Ollama), which preserves tool-calling
and the provider's `usage` block verbatim. The app uses `http://127.0.0.1:4000/v1`.

> Previously this sat in front of Portkey; Portkey's provider transform dropped
> `tools`/`tool_choice`, so we route direct instead.

Today tiers 2–5 map to **DeepSeek V4 Flash** (the reliable cheap workhorse) and
tier-6 to **DeepSeek V4 Pro**; tier-1 is local Ollama. On non-streaming failure,
a tier escalates up then sweeps the lower paid rungs before returning an error.
Streaming requests use the first matching target, because a stream cannot safely
retry after tokens have begun.

## Run

1. Ollama running locally with the models pulled (`ollama pull bge-m3`, `ollama pull llama3.2:1b`).
2. Copy `.env.example` to `.env`, set `DEEPSEEK_API_KEY` (tiers 2–6).
3. Start the gateway: `npm run dev -w @llm-wiki/llm-gateway`

Gateway base URL: `http://127.0.0.1:4000` (`/v1/chat/completions`, `/v1/embeddings`).
Optional env: `GATEWAY_PORT`, `GATEWAY_REQUEST_TIMEOUT_MS`, `DEEPSEEK_BASE_URL`.

## Centralized wiring

Every service except the host points at this gateway. The host stays on the
Claude subscription via the Agent SDK and is intentionally NOT routed here.

**Default-on (no env needed).** mail-mirror and mail-mcp now default their
embedding + role-classify endpoints to the gateway; mail-promoter already
defaults its classify/distill calls here. With the gateway up they Just Work.

- mail-mirror / mail-mcp embeddings → `http://127.0.0.1:4000/v1/embeddings`
  (model `local-embed`). Override with `MAIL_EMBED_ENDPOINT` / `MAIL_EMBED_MODEL`;
  disable with `MAIL_EMBED_ENDPOINT=off`.
- mail-mirror role-classify → `http://127.0.0.1:4000/v1/chat/completions`
  (model `tier-2`). Override with `MAIL_CLASSIFY_ENDPOINT` / `MAIL_CLASSIFY_MODEL`;
  disable with `MAIL_CLASSIFY_ENDPOINT=off`.
- mail-promoter → `MAIL_PROMOTER_LLM_ENDPOINT` (default `http://127.0.0.1:4000`),
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
both streaming and non-streaming calls, with a per-request timeout
(`GATEWAY_REQUEST_TIMEOUT_MS`).

## Claude-subscription tier (retired, optional)

The capability tiers now use the cheap DeepSeek API rather than the Claude
subscription. The Agent-SDK adapter (`src/adapter.ts`) that bridged Claude on the
subscription is kept for reference: to put a subscription rung back, start it in a
process WITHOUT `ANTHROPIC_API_KEY` (so it uses the subscription, not the API) and
point a tier's `api_base` at `http://127.0.0.1:4001/v1`:

    cd apps/llm-gateway
    env -u ANTHROPIC_API_KEY node --import tsx src/adapter.ts   # listens on :4001

It exposes `claude-haiku-sub` / `claude-sonnet-sub` / `claude-opus-sub`; the
adapter refuses to start if `ANTHROPIC_API_KEY` is set.

## Smoke test (live)

With the gateway running:

    node --import tsx scripts/smoke.mts

Checks a `local-embed` embeddings call and a chat tier (JSON round-trip via
`extractJson`). Exits non-zero on failure.
