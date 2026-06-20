# LLM Gateway

One OpenAI-compatible endpoint for every service. Tiers, selected via `model`:
`local-*` (Ollama), `api-*` (OpenRouter free, with model+key rotation), `sub-*` (Phase 2).

## Run

1. Ollama running locally with the models pulled (`ollama pull bge-m3`, a chat model).
2. `pip install "litellm[proxy]"`
3. Copy `.env.example` to `.env`, set `OPENROUTER_API_KEY_1` (+ `_2` …).
4. `set -a; source .env; set +a; litellm --config litellm.config.yaml --port 4000`

Gateway base URL: `http://127.0.0.1:4000` (`/v1/chat/completions`, `/v1/embeddings`).

## Repoint services (Phase 1)

These are already endpoint-agnostic — change only the env (no code):

- mail-mirror: `MAIL_EMBED_ENDPOINT=http://127.0.0.1:4000/v1/embeddings`,
  `MAIL_EMBED_MODEL=local-embed`, `MAIL_CLASSIFY_ENDPOINT=http://127.0.0.1:4000/v1/chat/completions`,
  `MAIL_CLASSIFY_MODEL=api-default`.
- llm-wiki: point its embedding endpoint at `http://127.0.0.1:4000/v1/embeddings` (model `local-embed`).

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
specific Claude model; otherwise the subscription default applies. The adapter
refuses to start if `ANTHROPIC_API_KEY` is set.

## Smoke test (live)

With the gateway running:

    node --import tsx scripts/smoke.mts

Checks a `local-embed` embeddings call and an `api-default` OpenRouter chat
(JSON round-trip via `extractJson`). Exits non-zero on failure.
