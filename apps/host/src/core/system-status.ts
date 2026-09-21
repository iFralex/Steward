import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { recordAudit } from "@steward/audit-log";
import { usageLedger } from "@steward/usage-ledger";
import { stewardConfigDir, type HostConfig } from "../config.ts";
import type { PushRegistryStatus } from "./push.ts";
import { speechStatus } from "./speech.ts";
import { decideTool, type ToolDecision } from "./tool-policy.ts";
import type { VoiceChannelStatus } from "./voice-channel.ts";
import { sharedWatchEngine, watchDbPath } from "./watch-runtime.ts";
import { watchActivityStatus } from "./watch-observability.ts";

type ServiceState = "ok" | "warning" | "error" | "unknown";

export interface SystemServiceStatus {
  id: string;
  label: string;
  state: ServiceState;
  detail?: string;
  checks?: SystemServiceCheck[];
  tools?: number;
  toolDetails?: SystemToolStatus[];
  updatedAt: number;
}

export interface SystemServiceCheck {
  name: string;
  ok: boolean;
  detail?: string;
  verified?: boolean;
}

export interface SystemToolStatus {
  name: string;
  qualifiedName: string;
  source: string;
  decision: ToolDecision | "interactive";
  scope: "chat" | "call" | "watch" | "all";
  calls: number;
  errors: number;
  lastUsedAt?: number;
  lastOk?: boolean;
}

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  label: string;
  plistPath: string;
  appPath: string | null;
  detail?: string;
}

export interface SystemStatus {
  generatedAt: number;
  bundled: boolean;
  autostart: AutostartStatus;
  services: SystemServiceStatus[];
  toolTotals: { available: number; used: number; errors: number };
}

export interface SystemStatusContext {
  voice?: VoiceChannelStatus;
  push?: PushRegistryStatus;
}

const LAUNCH_AGENT_LABEL = "com.llm-wiki.launcher";
const GATEWAY_URL = "http://127.0.0.1:4000/health";
const OLLAMA_URL = "http://127.0.0.1:11434/api/tags";
const LLM_WIKI_URL = "http://127.0.0.1:19828/api/v1/health";
const discoveredTools = new Map<string, string[]>();
const bundledToolNames: Record<string, string[]> = {
  "llm-wiki": ["llm_wiki_status", "llm_wiki_projects", "llm_wiki_files", "llm_wiki_read_file", "llm_wiki_reviews", "llm_wiki_search", "llm_wiki_graph", "llm_wiki_rescan_sources", "llm_wiki_add_source", "llm_wiki_create_folder", "llm_wiki_show_window", "llm_wiki_hide_window"],
  mail: ["list_mailboxes", "search_messages", "read_message", "save_attachment", "send_email", "reply", "list_scheduled", "cancel_scheduled", "get_thread"],
  calendar: ["list_calendars", "search_events", "read_event", "create_event", "update_event", "delete_event"],
  contacts: ["search_contacts", "read_contact", "resolve_recipient", "create_contact", "update_contact"],
  "action-center": ["list_actions", "read_action", "mark_action", "list_flows", "search_flows", "create_flow", "update_flow", "set_flow_enabled", "delete_flow"],
  shell: ["find_files", "run_command", "run_write_command"],
  trains: ["find_next_train", "train_status"],
};

export async function loadSystemStatus(config: HostConfig, context: SystemStatusContext = {}): Promise<SystemStatus> {
  const generatedAt = Date.now();
  const usage = toolUsage();
  const mcpEntries = Object.entries(config.mcpServers).filter(([id]) => id !== "voice");
  const checks = await Promise.all([
    httpStatus("host", "Host", `http://127.0.0.1:${config.port}/health`),
    gatewayStatus(),
    ollamaStatus(),
    Promise.resolve(localSpeechStatus(config)),
    httpStatus("llm-wiki", "LLM Wiki API", LLM_WIKI_URL),
    schedulerStatus(),
    Promise.resolve(watchStatus()),
    Promise.resolve(pushStatus(context.push)),
    Promise.resolve(voiceStatus(config, context.voice, usage)),
    Promise.resolve(storageStatus()),
    Promise.resolve(macPermissionsStatus()),
    Promise.resolve(channelStatus(config, context)),
    Promise.resolve(hostToolsStatus(config, usage)),
    ...mcpEntries.map(([id, spec]) => mcpStatus(id, `MCP ${id}`, spec.command, spec.args, config, usage)),
  ]);
  recordHealthTransitions(checks);
  const allTools = checks.flatMap((service) => service.toolDetails ?? []);
  return {
    generatedAt,
    bundled: (process.env.STEWARD_BUNDLED_SERVICES ?? process.env.LLM_WIKI_BUNDLED_SERVICES) === "1",
    autostart: getAutostartStatus(),
    services: checks,
    toolTotals: {
      available: allTools.length,
      used: allTools.reduce((sum, tool) => sum + tool.calls, 0),
      errors: allTools.reduce((sum, tool) => sum + tool.errors, 0),
    },
  };
}

export function getAutostartStatus(): AutostartStatus {
  const plistPath = launchAgentPath();
  const appPath = resolveAppPath();
  const enabled = existsSync(plistPath);
  return {
    supported: process.platform === "darwin",
    enabled,
    label: LAUNCH_AGENT_LABEL,
    plistPath,
    appPath,
    detail: enabled && appPath && !plistMatchesApp(plistPath, appPath) ? "LaunchAgent exists but points to a different app path." : undefined,
  };
}

export function setAutostart(enabled: boolean): AutostartStatus {
  if (process.platform !== "darwin") {
    return { ...getAutostartStatus(), supported: false, detail: "Autostart is only implemented for macOS." };
  }

  const plistPath = launchAgentPath();
  if (!enabled) {
    try {
      if (existsSync(plistPath)) unlinkSync(plistPath);
    } catch (err) {
      return { ...getAutostartStatus(), detail: err instanceof Error ? err.message : String(err) };
    }
    return getAutostartStatus();
  }

  const appPath = resolveAppPath();
  if (!appPath) {
    return { ...getAutostartStatus(), detail: "Cannot resolve the current Steward.app path." };
  }

  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, launchAgentPlist(appPath), "utf8");
  return getAutostartStatus();
}

function localSpeechStatus(config: HostConfig): SystemServiceStatus {
  const status = speechStatus(config);
  return {
    id: "speech",
    label: "Speech",
    state: status.ok ? "ok" : "warning",
    detail: status.detail,
    checks: [{ name: "whisper.cpp", ok: status.ok, detail: status.detail }],
    updatedAt: Date.now(),
  };
}

async function httpStatus(id: string, label: string, url: string): Promise<SystemServiceStatus> {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(url, 2_500);
    const text = await res.text();
    return {
      id,
      label,
      state: res.ok ? "ok" : "warning",
      detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status}: ${text.slice(0, 160)}`,
      updatedAt: started,
    };
  } catch (err) {
    return { id, label, state: "error", detail: err instanceof Error ? err.message : String(err), updatedAt: started };
  }
}

async function gatewayStatus(): Promise<SystemServiceStatus> {
  const status = await httpStatus("gateway", "LLM Gateway", GATEWAY_URL);
  if (status.state !== "ok") return status;
  try {
    const res = await fetchWithTimeout("http://127.0.0.1:4000/v1/models", 2_500);
    const body = await res.json() as { data?: unknown[] };
    const count = body.data?.length ?? 0;
    return {
      ...status,
      state: count > 0 ? "ok" : "warning",
      detail: `${status.detail}; ${count} models`,
      checks: [
        { name: "health", ok: true, detail: status.detail },
        { name: "models", ok: count > 0, detail: `${count} models` },
      ],
    };
  } catch (err) {
    return {
      ...status,
      state: "warning",
      checks: [
        { name: "health", ok: true, detail: status.detail },
        { name: "models", ok: false, detail: err instanceof Error ? err.message : String(err) },
      ],
    };
  }
}

async function ollamaStatus(): Promise<SystemServiceStatus> {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(OLLAMA_URL, 2_500);
    const body = await res.json() as { models?: { name?: string }[] };
    const hasBge = body.models?.some((model) => model.name === "bge-m3" || model.name?.startsWith("bge-m3:")) ?? false;
    return {
      id: "ollama",
      label: "Ollama",
      state: hasBge ? "ok" : "warning",
      detail: hasBge ? "bge-m3 available" : "Ollama is running, but bge-m3 is missing.",
      checks: [
        { name: "tags", ok: true, detail: `${body.models?.length ?? 0} models` },
        { name: "embedding model", ok: hasBge, detail: hasBge ? "bge-m3 available" : "bge-m3 missing" },
      ],
      updatedAt: started,
    };
  } catch (err) {
    return { id: "ollama", label: "Ollama", state: "warning", detail: err instanceof Error ? err.message : String(err), updatedAt: started };
  }
}

async function schedulerStatus(): Promise<SystemServiceStatus> {
  const logPath = process.env.SCHED_LOG ?? join(homedir(), "Library", "Logs", "Steward", "scheduler.jsonl");
  try {
    const stat = statSync(logPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const content = readTail(logPath, 512 * 1024);
    const jobs = ["mail-reconcile", "write-ops-mail", "write-ops-send-due", "mail-embed", "mail-distill", "calendar-sync", "write-ops-calendar", "action-center"];
    const lines = content.split(/\r?\n/);
    const jobChecks = jobs.map((job) => {
      const line = [...lines].reverse().find((candidate) => candidate.includes(`[${job}]`) && /\b(ok|FAILED)\b/.test(candidate));
      if (!line) return { name: job, ok: false, verified: false, detail: "No result recorded" };
      const ok = /\] ok\b/.test(line);
      const timestamp = Date.parse(line.slice(0, 24));
      const detail = line.replace(/^\S+\s+\[[^\]]+\]\s*/, "").slice(0, 240);
      return { name: job, ok, verified: true, detail: `${detail}${Number.isFinite(timestamp) ? ` · ${formatAge(Date.now() - timestamp)} ago` : ""}` };
    });
    const stale = ageMs >= 30 * 60_000;
    const failed = jobChecks.filter((check) => check.verified && !check.ok).length;
    const state: ServiceState = stale || failed > 0 || jobChecks.some((check) => !check.verified) ? "warning" : "ok";
    return {
      id: "scheduler",
      label: "Scheduler",
      state,
      detail: `${failed ? `${failed} failed job${failed === 1 ? "" : "s"}; ` : ""}last log ${formatAge(ageMs)} ago`,
      checks: jobChecks,
      updatedAt: Date.now(),
    };
  } catch {
    return {
      id: "scheduler",
      label: "Scheduler",
      state: (process.env.STEWARD_SCHEDULER ?? process.env.LLM_WIKI_SCHEDULER) === "0" ? "unknown" : "warning",
      detail: "No scheduler log found yet.",
      updatedAt: Date.now(),
    };
  }
}

async function mcpStatus(
  id: string,
  label: string,
  command: string,
  args: string[],
  config: HostConfig,
  usage: ToolUsageMap,
): Promise<SystemServiceStatus> {
  const started = Date.now();
  let client: Client | null = null;
  try {
    const transport = new StdioClientTransport({ command, args });
    client = new Client({ name: "host-system-status", version: "0.0.0" }, { capabilities: {} });
    client.onerror = () => {};
    await withTimeout(client.connect(transport), 5_000);
    const tools = await withTimeout(client.listTools(), 5_000);
    discoveredTools.set(id, tools.tools.map((tool) => tool.name));
    const smoke = await mcpSmoke(id, client, tools.tools.map((tool) => tool.name));
    const state: ServiceState = smoke.verified === false || !smoke.ok ? "warning" : "ok";
    const toolDetails = tools.tools.map((tool) => toolStatus(id, tool.name, config, usage));
    return {
      id: `mcp-${id}`,
      label,
      state,
      detail: `${tools.tools.length} tools; ${smoke.verified === false ? "live check not configured" : `${smoke.name} ${smoke.ok ? "OK" : "failed"}`}`,
      checks: [
        { name: "tools/list", ok: tools.tools.length > 0, detail: `${tools.tools.length} tools` },
        smoke,
      ],
      tools: tools.tools.length,
      toolDetails,
      updatedAt: started,
    };
  } catch (err) {
    const names = discoveredTools.get(id) ?? bundledToolNames[id] ?? [];
    const toolDetails = names.map((name) => toolStatus(id, name, config, usage));
    return {
      id: `mcp-${id}`,
      label,
      state: "error",
      detail: err instanceof Error ? err.message : String(err),
      tools: toolDetails.length || undefined,
      toolDetails: toolDetails.length ? toolDetails : undefined,
      updatedAt: started,
    };
  } finally {
    try {
      await client?.close();
    } catch {
      /* already closed */
    }
  }
}

async function mcpSmoke(id: string, client: Client, toolNames: string[]): Promise<SystemServiceCheck> {
  const smoke = smokeCallFor(id);
  if (!smoke) return { name: "live check", ok: false, verified: false, detail: "Not configured; tool discovery only." };
  if (!toolNames.includes(smoke.tool)) {
    return { name: `call ${smoke.tool}`, ok: false, detail: "Tool is not listed." };
  }
  try {
    const result = await withTimeout(client.callTool({ name: smoke.tool, arguments: smoke.arguments }), 8_000) as {
      content?: unknown[];
    };
    const count = Array.isArray(result.content) ? result.content.length : 0;
    return { name: `call ${smoke.tool}`, ok: true, detail: `${count} content blocks` };
  } catch (err) {
    return { name: `call ${smoke.tool}`, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function smokeCallFor(id: string): { tool: string; arguments: Record<string, unknown> } | null {
  switch (id) {
    case "llm-wiki":
      return { tool: "llm_wiki_status", arguments: {} };
    case "mail":
      return { tool: "list_mailboxes", arguments: {} };
    case "calendar":
      return { tool: "list_calendars", arguments: {} };
    case "contacts":
      return { tool: "search_contacts", arguments: { query: "__llm_wiki_smoke__", limit: 1 } };
    case "action-center":
      return { tool: "list_actions", arguments: { limit: 1 } };
    case "shell":
      return { tool: "run_command", arguments: { command: "pwd", maxLines: 1 } };
    default:
      return null;
  }
}

type ToolUsageMap = Map<string, { calls: number; errors: number; lastUsedAt?: number; lastOk?: boolean }>;
function toolUsage(): ToolUsageMap {
  try {
    const ledger = usageLedger();
    const totals = new Map(ledger.summary().byTool.map((row) => [row.tool, { calls: row.calls, errors: row.errors }]));
    const recent = ledger.raw.prepare(
      "SELECT tool, MAX(ts) ts, ok FROM tool_calls GROUP BY tool",
    ).all() as Array<{ tool: string; ts: number; ok: number }>;
    const result: ToolUsageMap = new Map();
    for (const [tool, stats] of totals) result.set(tool, stats);
    for (const row of recent) {
      const current = result.get(row.tool) ?? { calls: 0, errors: 0 };
      if (current.lastUsedAt === undefined) result.set(row.tool, { ...current, lastUsedAt: row.ts, lastOk: row.ok === 1 });
    }
    return result;
  } catch {
    return new Map();
  }
}

function toolStatus(
  source: string,
  name: string,
  config: HostConfig,
  usage: ToolUsageMap,
  scope: SystemToolStatus["scope"] = "all",
  decision?: SystemToolStatus["decision"],
): SystemToolStatus {
  const qualifiedName = source === "host" ? name : `mcp__${source}__${name}`;
  const stats = usage.get(qualifiedName) ?? usage.get(name) ?? { calls: 0, errors: 0 };
  return { name, qualifiedName, source, decision: decision ?? decideTool(config.policy, qualifiedName), scope, ...stats };
}

function hostToolsStatus(config: HostConfig, usage: ToolUsageMap): SystemServiceStatus {
  const definitions: Array<[string, SystemToolStatus["scope"], SystemToolStatus["decision"]?]> = [
    ["ask_user", "chat", "interactive"],
    ["copy_to_clipboard", "chat"],
    ["create_watch", "watch"],
    ["create_agent_watch", "watch"],
    ["stop_watch", "watch"],
    ["set_voice_speech_rate", "call", "interactive"],
  ];
  const toolDetails = definitions.map(([name, scope, decision]) => toolStatus("host", name, config, usage, scope, decision));
  return {
    id: "host-tools", label: "Host tools", state: "ok", tools: toolDetails.length, toolDetails,
    detail: `${toolDetails.length} native tools; ${toolDetails.filter((tool) => tool.scope === "call").length} call-only`, updatedAt: Date.now(),
  };
}

function voiceStatus(
  config: HostConfig,
  voice: VoiceChannelStatus | undefined,
  usage: ToolUsageMap,
): SystemServiceStatus {
  const names = ["call_start", "converse", "get_conversation", "speak", "listen", "call_end", "call_status"];
  const toolDetails = names.map((name) => toolStatus("voice", name, config, usage, "call"));
  if (!voice || !voice.enabled) {
    return { id: "mcp-voice", label: "Voice / Ringback", state: "unknown", detail: voice?.detail ?? "Voice channel disabled", tools: toolDetails.length, toolDetails, updatedAt: Date.now() };
  }
  const failed = voice.state === "failed";
  const checks: SystemServiceCheck[] = [
    { name: "transport", ok: true, detail: `${voice.transport} · ${voice.state}` },
  ];
  if (config.voice.transport === "ringback") {
    const model = ringbackWhisperModel(config.voice.launcher);
    checks.push({ name: "phone transcription", ok: !!model && existsSync(model), detail: model ? (existsSync(model) ? model : `Missing: ${model}`) : "WHISPER_MODEL not configured" });
  }
  return {
    id: "mcp-voice", label: "Voice / Ringback", state: failed || checks.some((check) => !check.ok) ? "warning" : "ok",
    detail: failed ? voice.detail : `${voice.transport} · ${voice.state}; checked without starting a second process`,
    checks, tools: toolDetails.length, toolDetails, updatedAt: voice.updatedAt,
  };
}

function ringbackWhisperModel(launcher: string): string | null {
  if (!launcher) return null;
  const envPath = join(dirname(launcher), "voice.env");
  try {
    const line = readFileSync(envPath, "utf8").split(/\r?\n/).find((candidate) => /^(?:export\s+)?WHISPER_(?:SERVER_)?MODEL=/.test(candidate.trim()));
    if (!line) return null;
    return line.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2")
      .replace(/^~(?=\/)/, homedir())
      .replace(/^\$\{?HOME\}?/, homedir());
  } catch {
    return null;
  }
}

function watchStatus(): SystemServiceStatus {
  try {
    const active = sharedWatchEngine().store.active();
    const activity = watchActivityStatus();
    const failed = activity.lastPoll?.ok === false;
    return {
      id: "watchers", label: "Event watchers", state: failed ? "warning" : "ok",
      detail: `${active.length} active watcher${active.length === 1 ? "" : "s"}`,
      checks: [
        { name: "store", ok: existsSync(watchDbPath()), detail: watchDbPath() },
        { name: "last poll", ok: !failed, verified: !!activity.lastPoll, detail: activity.lastPoll ? `${activity.lastPoll.source} · ${activity.lastPoll.ok ? "OK" : activity.lastPoll.error ?? "failed"} · ${formatAge(Date.now() - activity.lastPoll.at)} ago` : "No poll in this host process" },
        { name: "last delivery", ok: activity.lastDelivery?.ok ?? true, verified: !!activity.lastDelivery, detail: activity.lastDelivery ? `${activity.lastDelivery.ok ? "OK" : "failed"} · ${formatAge(Date.now() - activity.lastDelivery.at)} ago` : "No delivery in this host process" },
      ], updatedAt: Date.now(),
    };
  } catch (err) {
    return { id: "watchers", label: "Event watchers", state: "error", detail: errorText(err), updatedAt: Date.now() };
  }
}

function pushStatus(push?: PushRegistryStatus): SystemServiceStatus {
  if (!push) return { id: "push", label: "Web Push", state: "unknown", detail: "Registry status unavailable", updatedAt: Date.now() };
  const last = push.lastDelivery;
  const failed = !!last && last.report.failed > 0;
  return {
    id: "push", label: "Web Push", state: push.subscriptions === 0 || failed ? "warning" : "ok",
    detail: `${push.subscriptions} server subscription${push.subscriptions === 1 ? "" : "s"}`,
    checks: [
      { name: "subscriptions", ok: push.subscriptions > 0, detail: String(push.subscriptions) },
      { name: "last delivery", ok: !failed && !!last && last.report.delivered > 0, verified: !!last, detail: last ? `${last.report.delivered}/${last.report.attempted} delivered · ${formatAge(Date.now() - last.at)} ago` : "No delivery in this host process" },
    ], updatedAt: last?.at ?? Date.now(),
  };
}

function storageStatus(): SystemServiceStatus {
  const base = stewardConfigDir();
  const databases = [
    { name: "chats", path: join(process.env.CHATS_DIR ?? join(homedir(), "Library", "Application Support", "steward-chats"), "chats.db") },
    { name: "audit", path: join(process.env.AUDIT_DIR ?? join(homedir(), "Library", "Application Support", "steward-audit"), "audit.db") },
    { name: "usage", path: join(process.env.USAGE_DIR ?? join(homedir(), "Library", "Application Support", "steward-usage"), "usage.db") },
    { name: "watches", path: watchDbPath() },
    { name: "actions", path: process.env.ACTION_CENTER_DB ?? join(process.env.ACTION_CENTER_DIR ?? join(homedir(), "Library", "Application Support", "action-center"), "actions.db") },
  ];
  const checks = databases.map(({ name, path }) => {
    try { accessSync(path, constants.R_OK | constants.W_OK); return { name: `${name} database`, ok: true, detail: path }; }
    catch (err) { return { name: `${name} database`, ok: false, detail: existsSync(path) ? errorText(err) : `Missing: ${path}` }; }
  });
  try {
    const disk = statfsSync(base);
    const freeGb = disk.bavail * disk.bsize / 1_073_741_824;
    checks.push({ name: "free disk", ok: freeGb >= 1, detail: `${freeGb.toFixed(1)} GB` });
  } catch { /* directory checks still provide useful status */ }
  return { id: "storage", label: "Local data", state: checks.every((check) => check.ok) ? "ok" : "warning", detail: `${checks.length} storage checks`, checks, updatedAt: Date.now() };
}

function macPermissionsStatus(): SystemServiceStatus {
  if (process.platform !== "darwin") return { id: "permissions", label: "macOS data access", state: "unknown", detail: "macOS only", updatedAt: Date.now() };
  const locations = [
    { name: "Apple Mail", path: join(homedir(), "Library", "Mail") },
    { name: "Calendar", path: join(homedir(), "Library", "Calendars") },
  ];
  const checks = locations.map(({ name, path }) => {
    try { accessSync(path, constants.R_OK); return { name, ok: true, detail: "Readable" }; }
    catch { return { name, ok: false, detail: `Not readable: ${path}. Check Full Disk Access.` }; }
  });
  return { id: "permissions", label: "macOS data access", state: checks.every((check) => check.ok) ? "ok" : "warning", detail: `${checks.filter((check) => check.ok).length}/${checks.length} readable`, checks, updatedAt: Date.now() };
}

function channelStatus(config: HostConfig, context: SystemStatusContext): SystemServiceStatus {
  const speech = speechStatus(config);
  const checks: SystemServiceCheck[] = [
    { name: "Quick Send", ok: true, detail: "/quick-send" },
    { name: "Quick Call", ok: context.voice?.enabled ?? false, detail: context.voice?.enabled ? "/quick-call" : "Voice transport disabled" },
    { name: "audio transcription", ok: speech.ok, detail: speech.detail },
  ];
  return { id: "channels", label: "Input channels", state: checks.every((check) => check.ok) ? "ok" : "warning", detail: `${checks.filter((check) => check.ok).length}/${checks.length} available`, checks, updatedAt: Date.now() };
}

const previousHealth = new Map<string, ServiceState>();
function recordHealthTransitions(services: SystemServiceStatus[]): void {
  for (const service of services) {
    const previous = previousHealth.get(service.id);
    previousHealth.set(service.id, service.state);
    if (!previous || previous === service.state) continue;
    try {
      recordAudit({ actor: "host", eventType: "system.health_changed", risk: service.state === "error" ? "medium" : "low", summary: `${service.label}: ${previous} → ${service.state}`, ok: service.state === "ok", payload: { serviceId: service.id, previous, current: service.state, detail: service.detail } });
    } catch { /* health reporting must remain best-effort */ }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try { readSync(fd, buffer, 0, length, size - length); }
  finally { closeSync(fd); }
  return buffer.toString("utf8");
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function resolveAppPath(): string | null {
  const explicit = process.env.STEWARD_APP_PATH ?? process.env.LLM_WIKI_APP_PATH;
  if (explicit && explicit.endsWith(".app")) return explicit;

  const root = process.env.STEWARD_ROOT ?? process.env.LLM_WIKI_ROOT;
  if (!root) return null;
  const marker = ".app/Contents/Resources";
  const idx = root.indexOf(marker);
  if (idx >= 0) return root.slice(0, idx + ".app".length);
  return null;
}

function plistMatchesApp(plistPath: string, appPath: string): boolean {
  try {
    return readFileSync(plistPath, "utf8").includes(xmlEscape(appPath));
  } catch {
    return false;
  }
}

function launchAgentPlist(appPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>${xmlEscape(appPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function formatAge(ageMs: number): string {
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes === 1) return "1 minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
