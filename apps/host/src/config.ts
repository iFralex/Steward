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

loadDotEnv(new URL("../.env", import.meta.url));

/** Same convention as apps/llm-gateway: a local, gitignored .env for per-project overrides. */
function loadDotEnv(url: URL): void {
  const path = fileURLToPath(url);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export interface HostConfig {
  port: number;
  systemPrompt: string;
  policy: ToolPolicy;
  approvalTimeoutMs: number;
  gateway: GatewayConfig;
  speech: SpeechConfig;
  voice: VoiceChannelConfig;
  mcpServers: Record<string, McpServerSpec>;
  /** Shared secret gating the WS + HTTP data routes (mobile-access M0). */
  authToken: string;
  /** VAPID keypair for Web Push (mobile-access M2/M3). */
  vapid: VapidKeys;
}

/**
 * Voice is a channel, not a second agent. Ringback is the first transport;
 * StreamCore deliberately has a configuration shape already so it can later
 * replace the media path without changing the public `/voice/*` API.
 */
export type VoiceChannelConfig =
  | { transport: "disabled" }
  | { transport: "ringback"; launcher: string; openingLine: string; preflightTimeoutMs: number }
  | { transport: "streamcore"; baseUrl: string; openingLine: string };

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

export interface SpeechConfig {
  enabled: boolean;
  whisperBin?: string;
  whisperModel?: string;
  language: string;
  timeoutMs: number;
  convertTimeoutMs: number;
}

export function loadVoiceChannelConfig(env: NodeJS.ProcessEnv = process.env): VoiceChannelConfig {
  const transport = (env.STEWARD_VOICE_TRANSPORT ?? "disabled").trim().toLowerCase();
  const openingLine = (env.STEWARD_VOICE_OPENING_LINE ?? "Ciao, sono Steward. Come posso aiutarti?").trim();
  if (transport === "ringback") {
    return {
      transport,
      launcher: (env.STEWARD_RINGBACK_LAUNCHER ?? "").trim(),
      openingLine,
      preflightTimeoutMs: Math.max(1_000, Number(env.STEWARD_VOICE_PREFLIGHT_TIMEOUT_MS ?? 10_000)),
    };
  }
  if (transport === "streamcore") {
    return {
      transport,
      baseUrl: (env.STEWARD_STREAMCORE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, ""),
      openingLine,
    };
  }
  return { transport: "disabled" };
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
  "Reusable workflows are explicit user-authored preferences. Only call",
  "mcp__action-center__create_flow when the user clearly asks to create/save a",
  "flow from instructions they just gave; never infer or learn one silently.",
  "Put the triggering situation in `when`, the desired outcome and sequence in",
  "`guidance`, and exceptions in `exclusions`. Flow writes require approval and",
  "remain editable. Use list/search/update/enable/delete tools to manage them.",
  "For email, use ONLY Apple Mail (mcp__mail__*) — search, read, send, reply.",
  "For Italian train information, use mcp__trains__find_next_train and report",
  "whether the platform is confirmed, scheduled-only, or unknown, plus the data",
  "update time. Never present a scheduled platform as confirmed. Use train_status",
  "to refresh a returned trainRef.",
  "Use create_watch when the user asks to be notified about future state",
  "changes. Use create_agent_watch instead when the user explicitly asks the",
  "future event turn to perform an action such as calling or sending an email.",
  "Put grants only on the exact rules that need the action and set once=true.",
  "A mail grant must contain already-resolved exact recipients, subject, and",
  "bodyTemplate; resolve contacts before proposing the watch. For a relative",
  "deadline use trigger before_time with estimatedArrivalMs. Creating an agent",
  "watch requires approval.",
  "Watches are generic: preserve the user's wording in",
  "`instruction`, express milestones as event rules, and use stop_watch to stop",
  "one. For a train, useful events include train.platform_announced,",
  "train.platform_confirmed, train.platform_changed, train.departed,",
  "train.stop_arrived, train.cancelled and train.arrived; a stop event with",
  "positionRelativeToDestination -1 is the preceding stop and 0 the destination.",
  "If the train already has a scheduled-only platform, watch confirmation and",
  "changes rather than waiting for platform_announced, which has already happened.",
  "To find files on the user's disk (e.g. to attach to an email), use",
  "mcp__shell__find_files, then pass the returned absolute paths to send_email/",
  "reply `attachments`. mcp__shell__run_command runs a read-only command line in",
  "normal shell syntax WITH pipes (safe, no real shell) — e.g. newest file:",
  "\"ls -t ~/Downloads | head -1\". run_write_command mutates files (needs approval).",
  "Sensitive actions (sending email, creating events, writing files) require",
  "the user's approval — propose them via the appropriate tool and the host",
  "will ask the user to confirm. Never claim a sensitive action is done.",
  "When the user asks you to copy exact text to their clipboard, use the",
  "`copy_to_clipboard` tool with that text. It is gated: the client copies to",
  "the local device clipboard only after the user approves.",
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
  const trainMcpEntry =
    process.env.TRAIN_MCP_ENTRY ?? fileURLToPath(new URL("../../train-mcp/src/index.ts", import.meta.url));
  const voice = loadVoiceChannelConfig();

  const vapid = loadVapidKeys();
  // Apple's push service (web.push.apple.com) VALIDATES the VAPID subject and
  // rejects fake domains with 403 BadJwtToken ("mailto:steward@localhost"
  // meant no push ever reached an iPhone). Must be a real mailto: or https: URI.
  const pushContact = process.env.STEWARD_PUSH_CONTACT ?? "mailto:ifralex.developer@gmail.com";
  webpush.setVapidDetails(pushContact, vapid.publicKey, vapid.privateKey);

  const mcpServers: Record<string, McpServerSpec> = {
    "llm-wiki": { command: node, args: [llmWikiMcpEntry] },
    mail: { command: node, args: nodeArgs(mailMcpEntry) },
    calendar: { command: node, args: nodeArgs(calendarMcpEntry) },
    contacts: { command: node, args: nodeArgs(contactsMcpEntry) },
    "action-center": { command: node, args: nodeArgs(actionCenterMcpEntry) },
    shell: { command: node, args: nodeArgs(shellMcpEntry) },
    trains: { command: node, args: nodeArgs(trainMcpEntry) },
  };
  // Keep the MCP id transport-neutral. A future StreamCore adapter can expose
  // the same host-facing voice channel without renaming tools throughout Steward.
  if (voice.transport === "ringback" && voice.launcher) {
    mcpServers.voice = { command: voice.launcher, args: [] };
  }

  const voicePrompt = voice.transport === "ringback"
    ? [
        "Voice calls use mcp__voice__call_start, then mcp__voice__converse for every turn, and mcp__voice__call_end when finished.",
        "Start a call only after an explicit user request or a host voice-call instruction.",
        "Keep spoken lines short, natural, and in the user's language.",
        "A spoken confirmation never bypasses Steward's normal approval gate for sensitive actions; ask the user to approve those in the app.",
      ].join(" ")
    : "";

  return {
    port: Number(process.env.HOST_PORT ?? 4317),
    systemPrompt: [process.env.HOST_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT, voicePrompt].filter(Boolean).join(" "),
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
    speech: {
      enabled: process.env.STEWARD_SPEECH_ENABLED !== "0",
      whisperBin: process.env.STEWARD_WHISPER_BIN,
      whisperModel: process.env.STEWARD_WHISPER_MODEL,
      language: process.env.STEWARD_SPEECH_LANGUAGE ?? "en",
      timeoutMs: Number(process.env.STEWARD_SPEECH_TIMEOUT_MS ?? 120_000),
      convertTimeoutMs: Number(process.env.STEWARD_AUDIO_CONVERT_TIMEOUT_MS ?? 30_000),
    },
    voice,
    mcpServers,
  };
}
