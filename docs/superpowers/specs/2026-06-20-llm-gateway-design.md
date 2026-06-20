# Unified LLM Gateway — Design

Sub-project 3 of the personal-agent platform. A single OpenAI-compatible endpoint
that every service (mail-mirror, llm-wiki, the future mail-promoter, the host)
points at. The caller selects the model per request — from a local model, to a
paid API model, to Claude on the subscription — and the gateway routes,
falls back, and tracks cost in one place. See [[personal-agent-platform-roadmap]]
and [[personal-agent-architecture]].

## Goal

Stop every service from hardcoding its own LLM endpoint/model. Instead:

- one endpoint, `model:`-selectable, exposing **three tiers**:
  - `local-*` — Ollama / LM Studio (private, free, bulk-friendly);
  - `api-*` — paid or free-tier provider APIs (Anthropic API, etc.);
  - `sub-*` — Claude on the **subscription**, via a headless Agent-SDK adapter
    (quality at low volume; not for bulk).
- existing services repoint by **changing only their base URL** — they are
  already endpoint-agnostic (the injected, config-gated pattern from
  [[mail-advanced-search]] Plan A and the wiki embedding layer), so no logic
  changes.
- embeddings are fronted too (`/v1/embeddings` → Ollama bge-m3), so the
  embedding config also points at the gateway.

## Non-Goals

- **No concrete model selection in code.** Which local/api/sub model is the
  default is **configuration**, decided later. The design wires the routing
  *structure* (three tiers + naming), not specific model IDs.
- No change to the *logic* of mail-mirror, llm-wiki, or packages/embedding —
  only their endpoint base URL (env/config). The wiki embedding gate (90/90)
  must stay green.
- Not a bulk path for `sub-*`: the subscription adapter is low-volume only
  (ToS + throughput); bulk classification stays on `local-*`.

## Key Decisions

1. **LiteLLM as the proxy.** Battle-tested OSS gateway: OpenAI-compatible in,
   100+ providers out (Ollama/LM Studio local, Anthropic API, free-tier APIs),
   with per-model routing, fallbacks, retries, key management, and cost/usage
   logging. Config-driven (`model_list` yaml). We do not hand-roll a router.
2. **API backends from the start.** Phase 1 wires both `local-*` (Ollama) and
   `api-*` (provider APIs) — not local-only.
3. **Subscription via a custom Agent-SDK adapter.** Off-the-shelf gateways
   can't use the claude.ai subscription (it's not a programmable API; it's
   OAuth bound to Claude Code / the Agent SDK). The host **already** runs the
   Claude Agent SDK on the subscription (`@anthropic-ai/claude-agent-sdk`
   `query()`, with `ANTHROPIC_API_KEY` deliberately unset). A small HTTP
   adapter wraps a headless single-shot `query()` (no tools) and returns the
   text in OpenAI shape; LiteLLM registers it as an OpenAI-compatible backend,
   exposing `sub-*` models. **Low volume only** — the agent runtime is heavier
   than a raw API call, and using the subscription as a bulk API backend is
   outside its intended (interactive) use.
4. **Model IDs are configuration.** The three tiers are a *naming convention*
   (`local-*` / `api-*` / `sub-*`); the concrete model behind each name lives
   in the LiteLLM config, chosen later and changeable without code edits.

## Architecture

```
service (mail-mirror / llm-wiki / mail-promoter / host)
        │  OpenAI-compatible  /v1/chat/completions , /v1/embeddings
        ▼
┌─────────────────────── LiteLLM proxy (gateway) ───────────────────────┐
│  model_list (config):                                                 │
│   local-*  → Ollama / LM Studio        (http://127.0.0.1:11434)       │
│   api-*    → Anthropic API / free-tier  (provider + key from env)     │
│   sub-*    → Agent-SDK adapter          (http://127.0.0.1:<adapter>)  │
│  + fallbacks, retries, cost/usage logging                             │
└───────────────────────────────────────────────────────────────────────┘
                                   │ sub-*
                                   ▼
                 Agent-SDK adapter (Node, OpenAI-compatible)
                 wraps  query({prompt, options:{no tools}})
                 process WITHOUT ANTHROPIC_API_KEY  → subscription auth
```

### Components

- **`apps/llm-gateway/litellm.config.yaml`** — the LiteLLM `model_list` mapping
  tier names → providers, keys via `os.environ/…`, plus `fallbacks` and
  logging. Concrete model IDs are placeholders to be filled in config.
- **`apps/llm-gateway/src/adapter.ts`** — the Agent-SDK adapter: an HTTP server
  exposing `POST /v1/chat/completions` (and a `GET /v1/models`), translating an
  OpenAI chat request into a single `query({ prompt, options })` call from
  `@anthropic-ai/claude-agent-sdk` (tools disabled, `settingSources: []`,
  single turn), accumulating the assistant text, and returning a minimal
  OpenAI `chat.completion` object. Streaming optional (return non-streamed
  first; `stream:true` can be added later).
- **`apps/llm-gateway/README.md`** — how to run: start the adapter (Node,
  no `ANTHROPIC_API_KEY`), start LiteLLM (`litellm --config litellm.config.yaml`),
  and the gateway base URL services point at.
- **Repoint config** — mail-mirror env (`MAIL_EMBED_ENDPOINT`,
  `MAIL_CLASSIFY_ENDPOINT`) and the wiki embedding endpoint set to the gateway
  URL. Documented in the gateway README / `.env.example`; no service code
  changes.

## Data Flow

1. A service calls the gateway with `{ model: "local-…" | "api-…" | "sub-…", messages }`
   (or `/v1/embeddings` with an embedding model name).
2. LiteLLM matches the model name to a `model_list` entry and forwards to the
   backend, applying any configured fallback on error.
3. For `sub-*`, the backend is the adapter, which runs `query()` on the
   subscription and returns the completion.
4. The response comes back in OpenAI shape; the service consumes it exactly as
   it does today (no code change).

## Phasing

- **Phase 1 — Gateway + local + api.** Stand up LiteLLM with `local-*` (Ollama
  chat + bge-m3 embeddings) and `api-*` (a provider API) backends. Repoint
  mail-mirror (embeddings + classifier) and llm-wiki at the gateway. Parity:
  the wiki embedding gate stays green; a mail embedding/classify smoke works
  through the gateway.
- **Phase 2 — Subscription adapter.** Build `apps/llm-gateway/src/adapter.ts`,
  register `sub-*` in the LiteLLM config, validate a low-volume chat completion
  end-to-end on the subscription. Document the throughput/ToS boundary.

Each phase is its own implementation plan.

## Error Handling

- LiteLLM handles provider errors/timeouts with configured fallbacks/retries;
  a fully-failed call returns a standard OpenAI error, which services already
  treat as "endpoint unavailable" and degrade gracefully (the Plan A injected
  pattern: no endpoint → no-op, never throws into ingest/search).
- The adapter is best-effort: a `query()` failure returns an OpenAI-shaped
  error (non-2xx); it never crashes the gateway. The adapter process must run
  **without** `ANTHROPIC_API_KEY` (else it bills the API instead of the
  subscription) — asserted at startup with a clear log.

## Testing

- **Adapter unit tests** (`node --test`): an OpenAI chat request maps to a
  single `query()` call (injected/stubbed) and the streamed assistant messages
  are assembled into a correct OpenAI `chat.completion` body; a `query()`
  failure yields an OpenAI error shape; the startup guard rejects a present
  `ANTHROPIC_API_KEY`.
- **Parity**: the wiki embedding test suite (90/90) stays green unchanged
  (it does not point at the gateway in tests — only runtime config changes);
  a mail embedding/classify smoke through the running gateway returns vectors
  / a role, demonstrating the repoint works.
- LiteLLM itself is configuration, validated by a smoke (a `/v1/models` list
  and one chat round-trip per tier), not unit tests.

## Constraints

- The adapter and any `sub-*` usage are **low-volume only**.
- LiteLLM is an external (Python) process; `apps/llm-gateway` holds its config
  and run instructions, not a vendored copy. The adapter is Node/TS in the
  monorepo.
- Services stay endpoint-agnostic; only base URLs move. No edits to
  `packages/embedding` or the wiki/mail *logic*.
