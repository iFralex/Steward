/**
 * Host configuration. Engine = Pi (@earendil-works/pi-coding-agent) on the LLM
 * gateway (OpenAI-compatible). Precondition: the gateway is up on baseUrl and
 * DEEPSEEK_API_KEY is set in the gateway's env (not here).
 */
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { defaultPolicy, type ToolPolicy } from "./core/tool-policy.ts";
import type { McpServerSpec } from "@steward/mcp-bridge";
import type { GatewayConfig } from "./core/pi-provider.ts";

export interface HostConfig {
  port: number;
  systemPrompt: string;
  policy: ToolPolicy;
  approvalTimeoutMs: number;
  gateway: GatewayConfig;
  mcpServers: Record<string, McpServerSpec>;
  /** Shared secret gating the WS + HTTP data routes (mobile-access M0). */
  authToken: string;
  /** VAPID keypair for Web Push (mobile-access M2/M3). */
  vapid: VapidKeys;
}

/** ~/Library/Application Support/Steward — created on demand. */
export function stewardConfigDir(): string {
  const dir = join(homedir(), "Library", "Application Support", "Steward");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where `PushRegistry` persists subscriptions (mobile-access M2/M3). */
export function pushSubscriptionsPath(): string {
  return join(stewardConfigDir(), "push-subscriptions.json");
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * VAPID keypair for Web Push: generated once via `web-push.generateVAPIDKeys()`
 * and persisted to `<Steward config dir>/vapid.json` (mode 0o600) so it survives
 * restarts — a rotated key would invalidate every existing browser subscription.
 */
export function loadVapidKeys(): VapidKeys {
  const path = join(stewardConfigDir(), "vapid.json");
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidKeys>;
      if (parsed.publicKey && parsed.privateKey) return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    } catch {
      /* corrupt file — regenerate below */
    }
  }
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

/**
 * Resolve the host's auth token: `STEWARD_AUTH_TOKEN` env var if set, else a
 * value persisted at `<Steward config dir>/auth-token`, else a freshly
 * generated one (written to that file, mode 0o600, for reuse across restarts).
 */
export function loadAuthToken(): string {
  if (process.env.STEWARD_AUTH_TOKEN) return process.env.STEWARD_AUTH_TOKEN;
  const path = join(stewardConfigDir(), "auth-token");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
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
  "When you present files found on disk, prefer `file` cards (one per file, with",
  "the absolute path) so the user can open/drag/attach them. For the cards to be",
  "actionable, use absolute paths (from find_files, or `find <dir> …` — not bare",
  "`ls` names).",
].join(" ");

export function loadConfig(): HostConfig {
  const bundled = (process.env.STEWARD_BUNDLED_SERVICES ?? process.env.LLM_WIKI_BUNDLED_SERVICES) === "1";
  const node = process.env.STEWARD_NODE ?? process.env.LLM_WIKI_NODE ?? process.execPath;
  const nodeArgs = (entry: string) => bundled ? [entry] : ["--import", "tsx", entry];
  const llmWikiMcpEntry =
    process.env.STEWARD_MCP_ENTRY ??
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

  const vapid = loadVapidKeys();
  webpush.setVapidDetails("mailto:steward@localhost", vapid.publicKey, vapid.privateKey);

  return {
    port: Number(process.env.HOST_PORT ?? 4317),
    systemPrompt: process.env.HOST_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
    policy: defaultPolicy,
    approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 5 * 60_000),
    authToken: loadAuthToken(),
    vapid,
    gateway: {
      baseUrl: process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:4000/v1",
      tier: process.env.HOST_TIER ?? "tier-5",
      apiKey: process.env.GATEWAY_API_KEY ?? "sk-local",
      // tier-5 (flash) cost, used by Pi at model registration for its own cost
      // tracking. The Usage page's display now comes from the gateway's
      // /rates endpoint (single source of truth); this is only the fallback
      // used if the gateway is unreachable.
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
    },
    mcpServers: {
      "llm-wiki": { command: node, args: [llmWikiMcpEntry] },
      mail: { command: node, args: nodeArgs(mailMcpEntry) },
      calendar: { command: node, args: nodeArgs(calendarMcpEntry) },
      contacts: { command: node, args: nodeArgs(contactsMcpEntry) },
      "action-center": { command: node, args: nodeArgs(actionCenterMcpEntry) },
      shell: { command: node, args: nodeArgs(shellMcpEntry) },
    },
  };
}
