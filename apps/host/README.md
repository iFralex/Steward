# Host

Pi-based personal-agent host. Engine: `@earendil-works/pi-coding-agent` on the
LLM gateway (capability tier `tier-5`, OpenAI-compatible).

## Run
1. Start the gateway (with `DEEPSEEK_API_KEY` in its env):
   `litellm --config apps/llm-gateway/litellm.config.yaml --port 4000`
2. Start the LLM Wiki desktop app (the wiki MCP server talks to its local API).
3. `npm run dev -w @llm-wiki/host` and `npm run dev -w @llm-wiki/web`.

## Env
- `GATEWAY_BASE_URL` (default `http://127.0.0.1:4000/v1`), `HOST_TIER` (default `tier-5`).
- `GATEWAY_API_KEY` (default `sk-local`; the gateway needs no real key by default).
- `ANTHROPIC_API_KEY` / Claude subscription are NO LONGER used.
