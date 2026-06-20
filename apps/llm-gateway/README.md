# LLM Gateway

One OpenAI-compatible endpoint for every service. Tiers, selected via `model`:
`local-*` (Ollama), `api-*` (OpenRouter free, with model+key rotation), `sub-*` (Phase 2).

## Run

1. Ollama running locally with the models pulled (`ollama pull bge-m3`, a chat model).
2. `pip install "litellm[proxy]"`
3. Copy `.env.example` to `.env`, set `OPENROUTER_API_KEY_1` (+ `_2` …).
4. `set -a; source .env; set +a; litellm --config litellm.config.yaml --port 4000`

Gateway base URL: `http://127.0.0.1:4000` (`/v1/chat/completions`, `/v1/embeddings`).

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
  (model `local-chat`). Override with `MAIL_CLASSIFY_ENDPOINT` / `MAIL_CLASSIFY_MODEL`;
  disable with `MAIL_CLASSIFY_ENDPOINT=off`.
- mail-promoter → `MAIL_PROMOTER_LLM_ENDPOINT` (default `http://127.0.0.1:4000`),
  classify=`local-chat`, distill=`sub-opus`.

> Heads-up: because embeddings default-on, `mail-mirror watch` / `mail-mirror embed`
> now embed the backlog through the gateway when run. Set `MAIL_EMBED_ENDPOINT=off`
> to keep them disabled.

**llm-wiki (manual, one-time).** llm-wiki reads its provider from app config,
not env, so it can't be wired in code here. In the llm-wiki UI add a custom
OpenAI-compatible provider with base URL `http://127.0.0.1:4000/v1` and select
`local-embed` for embeddings (and a chat model from the tiers above as needed).

## Resilience (api tier)

LiteLLM's router handles it (configured in `litellm.config.yaml`): key-pool
rotation (deployments sharing a `model_name`), model fallback (`fallbacks`),
retries + cooldown. Proxy fallback is out of scope.

## `sub-*` tier (Claude on the subscription)

Low-volume only. Start the adapter in a process WITHOUT `ANTHROPIC_API_KEY`
(so it uses the Claude subscription, not the API):

    cd apps/llm-gateway
    env -u ANTHROPIC_API_KEY node --import tsx src/adapter.ts   # listens on :4001

Then LiteLLM routes `model: sub-opus` to it. Optionally set `SUB_MODEL` to pin a
specific Claude model; otherwise the subscription default applies. When set,
`SUB_MODEL` overrides the model name requested by the caller. The adapter
refuses to start if `ANTHROPIC_API_KEY` is set.

## Smoke test (live)

With the gateway running:

    node --import tsx scripts/smoke.mts

Checks a `local-embed` embeddings call and an `api-default` OpenRouter chat
(JSON round-trip via `extractJson`). Exits non-zero on failure.
