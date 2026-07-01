/**
 * Host configuration. Engine = Pi (@earendil-works/pi-coding-agent) on the LLM
 * gateway (OpenAI-compatible). Precondition: the gateway is up on baseUrl and
 * DEEPSEEK_API_KEY is set in the gateway's env (not here).
 */
import { fileURLToPath } from "node:url";
import { defaultPolicy, type ToolPolicy } from "./core/tool-policy.ts";
import type { McpServerSpec } from "@llm-wiki/mcp-bridge";
import type { GatewayConfig } from "./core/pi-provider.ts";

export interface HostConfig {
  port: number;
  systemPrompt: string;
  policy: ToolPolicy;
  approvalTimeoutMs: number;
  gateway: GatewayConfig;
  mcpServers: Record<string, McpServerSpec>;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are the user's personal assistant.",
  "Use the LLM Wiki tools (mcp__llm-wiki__*) as your long-term memory:",
  "search and read the wiki before answering questions about the user's",
  "knowledge, projects, or documents.",
  "Use the Action Center tools (mcp__action-center__*) to inspect pending",
  "reply requests, scheduling requests, reminders, and their proposed plans.",
  "When the user discusses an action item, read the action first, then use",
  "mail, calendar, contacts, and LLM Wiki tools as needed to refine or execute",
  "the chosen plan.",
  "For email, use ONLY Apple Mail (mcp__mail__*) — search, read, send, reply.",
  "To find files on the user's disk (e.g. to attach to an email), use",
  "mcp__shell__find_files, then pass the returned absolute paths to send_email/",
  "reply `attachments`. mcp__shell__run_command runs a read-only command line in",
  "normal shell syntax WITH pipes (safe, no real shell) — e.g. newest file:",
  "\"ls -t ~/Downloads | head -1\". run_write_command mutates files (needs approval).",
  "Sensitive actions (sending email, creating events, writing files) require",
  "the user's approval — propose them via the appropriate tool and the host",
  "will ask the user to confirm. Never claim a sensitive action is done.",
  "To show a rich card inline in your reply, emit a fenced code block with",
  "language `card` containing JSON with a `type` field. Types:",
  "`email` {from, subject, date, body, mailUrl};",
  "`file` {path, name?} (a file on disk — the user can open/drag/attach it);",
  "`event` {summary, start, end, location, calendar, url};",
  "`search` {results:[{subject, from, date, mailUrl, snippet}]}.",
  "Use a card when presenting an email you read or sent, a saved file, or an",
  "event — e.g. write \"Ho inviato la mail:\" then the email card.",
  "When you present files found on disk (search results or a directory listing),",
  "render EACH file as its own `file` card with the ABSOLUTE path — do NOT use a",
  "markdown table or bullet list. For the cards to be openable/draggable, get",
  "absolute paths (from find_files, or `find <dir> …` — not bare `ls` names): e.g.",
  "list with `find ~/Downloads -maxdepth 1 -type f` and emit one file card per",
  "line. A short intro sentence before the cards is fine.",
].join(" ");

export function loadConfig(): HostConfig {
  const llmWikiMcpEntry =
    process.env.LLM_WIKI_MCP_ENTRY ??
    fileURLToPath(new URL("../../llm-wiki/mcp-server/dist/src/index.js", import.meta.url));
  const mailMcpEntry =
    process.env.MAIL_MCP_ENTRY ?? fileURLToPath(new URL("../../mail-mcp/src/index.ts", import.meta.url));
  const calendarMcpEntry =
    process.env.CALENDAR_MCP_ENTRY ?? fileURLToPath(new URL("../../calendar-mcp/src/index.ts", import.meta.url));
  const contactsMcpEntry =
    process.env.CONTACTS_MCP_ENTRY ?? fileURLToPath(new URL("../../contacts-mcp/src/index.ts", import.meta.url));
  const actionCenterMcpEntry =
    process.env.ACTION_CENTER_MCP_ENTRY ?? fileURLToPath(new URL("../../action-center/src/index.ts", import.meta.url));
  const shellMcpEntry =
    process.env.SHELL_MCP_ENTRY ?? fileURLToPath(new URL("../../shell-mcp/src/index.ts", import.meta.url));

  return {
    port: Number(process.env.HOST_PORT ?? 4317),
    systemPrompt: process.env.HOST_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
    policy: defaultPolicy,
    approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 5 * 60_000),
    gateway: {
      baseUrl: process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:4000/v1",
      tier: process.env.HOST_TIER ?? "tier-5",
      apiKey: process.env.GATEWAY_API_KEY ?? "sk-local",
      cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
    },
    mcpServers: {
      "llm-wiki": { command: process.execPath, args: [llmWikiMcpEntry] },
      mail: { command: process.execPath, args: ["--import", "tsx", mailMcpEntry] },
      calendar: { command: process.execPath, args: ["--import", "tsx", calendarMcpEntry] },
      contacts: { command: process.execPath, args: ["--import", "tsx", contactsMcpEntry] },
      "action-center": { command: process.execPath, args: ["--import", "tsx", actionCenterMcpEntry] },
      shell: { command: process.execPath, args: ["--import", "tsx", shellMcpEntry] },
    },
  };
}
