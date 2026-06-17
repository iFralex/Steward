/**
 * Host entrypoint. Starts the WebSocket server that the channel clients
 * (web UI first) connect to.
 *
 * Prerequisites at runtime: the user is logged into Claude Code (Pro
 * subscription) and ANTHROPIC_API_KEY is NOT set; the LLM Wiki desktop
 * app is running (so its MCP server can reach the local API).
 */
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

startServer(loadConfig());
