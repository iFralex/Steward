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

export interface HostConfig {
  port: number;
  model?: string;
  systemPrompt: string;
  policy: ToolPolicy;
  approvalTimeoutMs: number;
  mcpServers: Record<string, McpServerConfig>;
  /** Tools hidden from the agent entirely (account connectors we don't want). */
  disallowedTools: string[];
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are the user's personal assistant.",
  "Use the LLM Wiki tools (mcp__llm-wiki__*) as your long-term memory:",
  "search and read the wiki before answering questions about the user's",
  "knowledge, projects, or documents.",
  "For email, use ONLY Apple Mail (mcp__mail__*) — search, read, send, reply.",
  "Do NOT use Gmail or other Google/account connectors; they are disabled.",
  "Sensitive actions (sending email, running commands, writing files)",
  "require the user's approval — propose them via the appropriate tool",
  "and the host will ask the user to confirm.",
].join(" ");

/**
 * Account-level connectors the Agent SDK exposes from the Claude.ai login that
 * we hide from the agent (email is handled by Apple Mail only). The policy's
 * deny-prefixes are the deterministic backstop; this just stops the agent from
 * seeing/attempting them.
 */
const DISALLOWED_TOOLS = [
  "mcp__claude_ai_Gmail",
  "mcp__claude_ai_Google_Calendar",
  "mcp__claude_ai_Google_Drive",
];

export function loadConfig(): HostConfig {
  // Path to the LLM Wiki MCP server entry (built). Requires the LLM Wiki
  // desktop app to be running (the MCP server talks to its local HTTP API).
  const llmWikiMcpEntry =
    process.env.LLM_WIKI_MCP_ENTRY ??
    fileURLToPath(new URL("../../llm-wiki/mcp-server/dist/index.js", import.meta.url));

  // Mail MCP runs its TS entry directly via tsx (no build step).
  const mailMcpEntry =
    process.env.MAIL_MCP_ENTRY ??
    fileURLToPath(new URL("../../mail-mcp/src/index.ts", import.meta.url));

  // Calendar + Contacts MCP servers run their TS entries directly via tsx.
  const calendarMcpEntry =
    process.env.CALENDAR_MCP_ENTRY ??
    fileURLToPath(new URL("../../calendar-mcp/src/index.ts", import.meta.url));
  const contactsMcpEntry =
    process.env.CONTACTS_MCP_ENTRY ??
    fileURLToPath(new URL("../../contacts-mcp/src/index.ts", import.meta.url));

  return {
    port: Number(process.env.HOST_PORT ?? 4317),
    model: process.env.HOST_MODEL,
    systemPrompt: process.env.HOST_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
    policy: defaultPolicy,
    approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 5 * 60_000),
    mcpServers: {
      "llm-wiki": { type: "stdio", command: process.execPath, args: [llmWikiMcpEntry] },
      mail: { type: "stdio", command: process.execPath, args: ["--import", "tsx", mailMcpEntry] },
      calendar: { type: "stdio", command: process.execPath, args: ["--import", "tsx", calendarMcpEntry] },
      contacts: { type: "stdio", command: process.execPath, args: ["--import", "tsx", contactsMcpEntry] },
    },
    disallowedTools: DISALLOWED_TOOLS,
  };
}
