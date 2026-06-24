/**
 * Host entrypoint. Starts the WebSocket server that the channel clients
 * (web UI first) connect to.
 *
 * Prerequisites at runtime:
 *  - The LLM gateway must be reachable (default: http://127.0.0.1:4000/v1).
 *    The engine is Pi on the LLM gateway (OpenAI-compatible endpoint).
 *  - DEEPSEEK_API_KEY (and any other provider keys) live in the GATEWAY's
 *    environment, not the host's.
 *  - The LLM Wiki desktop app is running (so its MCP server can reach the
 *    local API).
 *  - Claude Pro subscription and ANTHROPIC_API_KEY are no longer used by
 *    the host.
 */
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

startServer(loadConfig());
