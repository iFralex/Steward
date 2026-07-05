import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HostConfig } from "../config.ts";
import { speechStatus } from "./speech.ts";

type ServiceState = "ok" | "warning" | "error" | "unknown";

export interface SystemServiceStatus {
  id: string;
  label: string;
  state: ServiceState;
  detail?: string;
  checks?: SystemServiceCheck[];
  tools?: number;
  updatedAt: number;
}

export interface SystemServiceCheck {
  name: string;
  ok: boolean;
  detail?: string;
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
}

const LAUNCH_AGENT_LABEL = "com.llm-wiki.launcher";
const GATEWAY_URL = "http://127.0.0.1:4000/health";
const OLLAMA_URL = "http://127.0.0.1:11434/api/tags";
const LLM_WIKI_URL = "http://127.0.0.1:19828/api/v1/health";

export async function loadSystemStatus(config: HostConfig): Promise<SystemStatus> {
  const generatedAt = Date.now();
  const checks = await Promise.all([
    httpStatus("host", "Host", `http://127.0.0.1:${config.port}/health`),
    gatewayStatus(),
    ollamaStatus(),
    Promise.resolve(localSpeechStatus(config)),
    httpStatus("llm-wiki", "LLM Wiki API", LLM_WIKI_URL),
    schedulerStatus(),
    ...Object.entries(config.mcpServers).map(([id, spec]) => mcpStatus(id, `MCP ${id}`, spec.command, spec.args)),
  ]);
  return {
    generatedAt,
    bundled: (process.env.STEWARD_BUNDLED_SERVICES ?? process.env.LLM_WIKI_BUNDLED_SERVICES) === "1",
    autostart: getAutostartStatus(),
    services: checks,
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
    const state: ServiceState = ageMs < 30 * 60_000 ? "ok" : "warning";
    return {
      id: "scheduler",
      label: "Scheduler",
      state,
      detail: `Last log ${formatAge(ageMs)} ago`,
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

async function mcpStatus(id: string, label: string, command: string, args: string[]): Promise<SystemServiceStatus> {
  const started = Date.now();
  let client: Client | null = null;
  try {
    const transport = new StdioClientTransport({ command, args });
    client = new Client({ name: "host-system-status", version: "0.0.0" }, { capabilities: {} });
    client.onerror = () => {};
    await withTimeout(client.connect(transport), 5_000);
    const tools = await withTimeout(client.listTools(), 5_000);
    const smoke = await mcpSmoke(id, client, tools.tools.map((tool) => tool.name));
    const state: ServiceState = smoke.ok ? "ok" : "warning";
    return {
      id: `mcp-${id}`,
      label,
      state,
      detail: `${tools.tools.length} tools; ${smoke.name} ${smoke.ok ? "OK" : "failed"}`,
      checks: [
        { name: "tools/list", ok: tools.tools.length > 0, detail: `${tools.tools.length} tools` },
        smoke,
      ],
      tools: tools.tools.length,
      updatedAt: started,
    };
  } catch (err) {
    return {
      id: `mcp-${id}`,
      label,
      state: "error",
      detail: err instanceof Error ? err.message : String(err),
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
  if (!smoke) return { name: "smoke", ok: true, detail: "No smoke call configured." };
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
