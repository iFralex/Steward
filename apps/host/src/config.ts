/**
 * Host configuration. Phase 1 keeps it simple and env-overridable.
 *
 * Auth: the Agent SDK uses the local Claude Code login (the user's Pro
 * subscription) — do NOT set ANTHROPIC_API_KEY in this process, or the
 * SDK bills pay-as-you-go instead.
 */
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { defaultPolicy, type ToolPolicy } from "./core/tool-policy.ts";
import { createDemoMcpServer } from "./tools/demo.ts";

export interface HostConfig {
  port: number;
  model?: string;
  systemPrompt: string;
  policy: ToolPolicy;
  approvalTimeoutMs: number;
  mcpServers: Record<string, McpServerConfig>;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are the user's personal assistant.",
  "Use the LLM Wiki tools (mcp__llm-wiki__*) as your long-term memory:",
  "search and read the wiki before answering questions about the user's",
  "knowledge, projects, or documents.",
  "Sensitive actions (sending email, running commands, writing files)",
  "require the user's approval — propose them via the appropriate tool",
  "and the host will ask the user to confirm.",
].join(" ");

export function loadConfig(): HostConfig {
  // Path to the LLM Wiki MCP server entry (built). Requires the LLM Wiki
  // desktop app to be running (the MCP server talks to its local HTTP API).
  const llmWikiMcpEntry =
    process.env.LLM_WIKI_MCP_ENTRY ??
    fileURLToPath(new URL("../../llm-wiki/mcp-server/dist/index.js", import.meta.url));

  return {
    port: Number(process.env.HOST_PORT ?? 4317),
    model: process.env.HOST_MODEL,
    systemPrompt: process.env.HOST_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
    policy: defaultPolicy,
    approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 5 * 60_000),
    mcpServers: {
      "llm-wiki": { type: "stdio", command: process.execPath, args: [llmWikiMcpEntry] },
      demo: createDemoMcpServer(),
    },
  };
}
