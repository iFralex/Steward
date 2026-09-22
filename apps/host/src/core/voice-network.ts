/** Optional, call-scoped Tailscale exit-node fallback for Ringback SIP. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:tls";
import { promisify } from "node:util";
import { recordAudit } from "@steward/audit-log";
import { stewardConfigDir } from "../config.ts";

const execFileAsync = promisify(execFile);
const TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const SIP_HOST = "sip.linphone.org";
const SIP_PORT = 5061;
const EXIT_NODE_SETTLE_MS = 20_000;
const EXIT_NODE_PROBE_INTERVAL_MS = 1_000;

export interface ExitNodeChoice { id: string; name: string; online: boolean }
export interface VoiceNetworkSettings { enabled: boolean; exitNodeId: string }
interface Journal { selectedId: string; previousId: string }
interface Peer { ID?: string; HostName?: string; DNSName?: string; Online?: boolean; ExitNodeOption?: boolean; TailscaleIPs?: string[] }
interface Status { Peer?: Record<string, Peer>; ExitNodeStatus?: { ID?: string } }

export function voiceNetworkSettingsPath(): string {
  return process.env.STEWARD_VOICE_NETWORK_SETTINGS_FILE ?? join(stewardConfigDir(), "voice-network.json");
}
function journalPath(): string { return `${voiceNetworkSettingsPath()}.journal`; }

export function getVoiceNetworkSettings(): VoiceNetworkSettings {
  const configuredId = process.env.STEWARD_VOICE_EXIT_NODE_ID?.trim();
  try {
    const raw = JSON.parse(readFileSync(voiceNetworkSettingsPath(), "utf8")) as Partial<VoiceNetworkSettings>;
    return { enabled: raw.enabled === true, exitNodeId: configuredId || (typeof raw.exitNodeId === "string" ? raw.exitNodeId : "") };
  } catch { return { enabled: Boolean(configuredId), exitNodeId: configuredId ?? "" }; }
}

export function setVoiceNetworkSettings(value: unknown, choices: ExitNodeChoice[]): VoiceNetworkSettings {
  if (!value || typeof value !== "object") throw new Error("Invalid network settings");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean" || typeof input.exitNodeId !== "string") throw new Error("enabled and exitNodeId are required");
  if (input.enabled && !choices.some((node) => node.id === input.exitNodeId)) throw new Error("Select an available exit node");
  const settings = { enabled: input.enabled, exitNodeId: input.exitNodeId };
  const path = voiceNetworkSettingsPath();
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(settings), { mode: 0o600 });
  renameSync(temp, path);
  recordAudit({ actor: "user", eventType: "settings.voice_network", risk: "medium", summary: "Voice network fallback updated", payload: settings });
  return settings;
}

export interface NetworkLease {
  enabled: boolean;
  /** Retry one pre-answer network failure via the configured exit node. */
  retryDial(): Promise<boolean>;
  release(): Promise<void>;
}

export interface VoiceNetworkDeps {
  status?: () => Promise<Status>;
  select?: (id: string) => Promise<void>;
  probe?: () => Promise<boolean>;
  settings?: () => VoiceNetworkSettings;
  journalFile?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

async function tailscale(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TAILSCALE, args, {
    env: { ...process.env, TAILSCALE_BE_CLI: "1" }, timeout: 8_000, maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function sipTlsProbe(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: SIP_HOST, port: SIP_PORT, servername: SIP_HOST, timeout: 3_000 });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("secureConnect", () => finish(socket.authorized));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function currentId(status: Status): string { return status.ExitNodeStatus?.ID ?? ""; }
function peerById(status: Status, id: string): Peer | undefined {
  return Object.values(status.Peer ?? {}).find((peer) => peer.ID === id);
}
function routeArg(status: Status, id: string): string {
  if (!id) return "";
  const peer = peerById(status, id);
  const ip = peer?.TailscaleIPs?.find((value) => /^100\./.test(value));
  if (!ip) throw new Error("Exit node is not available in Tailscale status");
  return ip;
}

/** One instance shared by every voice entry point; no other component changes routes. */
export class VoiceNetworkFallback {
  private readonly deps: Required<VoiceNetworkDeps>;
  private active = false;
  private readonly ready: Promise<void>;

  constructor(deps: VoiceNetworkDeps = {}) {
    this.deps = {
      status: deps.status ?? (async () => JSON.parse(await tailscale(["status", "--json"])) as Status),
      select: deps.select ?? (async (ip) => { await tailscale(["set", `--exit-node=${ip}`]); }),
      probe: deps.probe ?? sipTlsProbe,
      settings: deps.settings ?? getVoiceNetworkSettings,
      journalFile: deps.journalFile ?? journalPath(),
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
    // A previous host may have died mid-call. Restore before accepting a new lease.
    this.ready = this.restoreStale().catch((error) => {
      recordAudit({ actor: "host", eventType: "voice.network_restore_failed", risk: "medium", summary: String(error), ok: false });
    });
  }

  async choices(): Promise<ExitNodeChoice[]> {
    try {
      const status = await this.deps.status();
      return Object.values(status.Peer ?? {})
        .filter((peer) => peer.ExitNodeOption && peer.ID)
        .map((peer) => ({ id: peer.ID!, name: peer.HostName || peer.DNSName || peer.ID!, online: peer.Online === true }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  }

  async acquire(): Promise<NetworkLease> {
    await this.ready;
    if (existsSync(this.deps.journalFile)) await this.restoreStale();
    if (existsSync(this.deps.journalFile)) throw new Error("Previous call network route has not been restored");
    if (this.active) throw new Error("Voice network is already in use");
    this.active = true;
    let changed = false;
    let closed = false;
    const settings = this.deps.settings();
    const switchRoute = async (): Promise<boolean> => {
      if (!settings.enabled || !settings.exitNodeId || changed) return false;
      const status = await this.deps.status();
      const selected = peerById(status, settings.exitNodeId);
      if (!selected?.ExitNodeOption || !selected.Online) return false;
      const previousId = currentId(status);
      if (previousId === settings.exitNodeId) return false;
      const selectedIp = routeArg(status, settings.exitNodeId);
      // Write ahead so a crash during `tailscale set` can be recovered.
      const temp = `${this.deps.journalFile}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ selectedId: settings.exitNodeId, previousId } satisfies Journal), { mode: 0o600 });
      renameSync(temp, this.deps.journalFile);
      try {
        await this.deps.select(selectedIp);
        changed = true;
        recordAudit({ actor: "host", eventType: "voice.network_fallback_enabled", risk: "medium", summary: "Selected call exit node", ok: true, payload: { exitNodeId: settings.exitNodeId } });
        return true;
      } catch (error) {
        await this.restoreStale();
        throw error;
      }
    };
    const lease: NetworkLease = {
      enabled: settings.enabled,
      retryDial: async () => {
        if (closed) return false;
        if (!await switchRoute()) return false;
        return this.probeAfterSwitch();
      },
      release: async () => {
        if (closed) return;
        closed = true;
        try { if (changed || existsSync(this.deps.journalFile)) await this.restoreStale(); }
        catch (error) {
          recordAudit({ actor: "host", eventType: "voice.network_restore_failed", risk: "medium", summary: String(error), ok: false });
        }
        finally { this.active = false; }
      },
    };
    try {
      if (settings.enabled && !await this.deps.probe()) {
        if (await switchRoute() && !await this.probeAfterSwitch()) throw new Error("SIP is unreachable even through the selected exit node");
      }
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  private async probeAfterSwitch(): Promise<boolean> {
    // On macOS the CLI can acknowledge selection before the VPN route is
    // carrying new sockets. The previous three near-immediate probes rejected
    // a working iPhone exit node; a live test succeeded after ten seconds.
    const startedAt = this.deps.now();
    const deadline = startedAt + EXIT_NODE_SETTLE_MS;
    let attempts = 0;
    while (true) {
      attempts += 1;
      if (await this.deps.probe()) {
        recordAudit({ actor: "host", eventType: "voice.network_sip_ready", risk: "low",
          summary: "SIP TLS became reachable through call exit node", ok: true,
          payload: { attempts, elapsedMs: this.deps.now() - startedAt } });
        return true;
      }
      const remaining = deadline - this.deps.now();
      if (remaining <= 0) {
        recordAudit({ actor: "host", eventType: "voice.network_sip_unreachable", risk: "medium",
          summary: "SIP TLS stayed unreachable through call exit node", ok: false,
          payload: { attempts, elapsedMs: this.deps.now() - startedAt } });
        return false;
      }
      await this.deps.sleep(Math.min(EXIT_NODE_PROBE_INTERVAL_MS, remaining));
    }
  }

  private async restoreStale(): Promise<void> {
    if (!existsSync(this.deps.journalFile)) return;
    const journal = JSON.parse(readFileSync(this.deps.journalFile, "utf8")) as Journal;
    const status = await this.deps.status();
    // Never override a route the user changed while the call was in progress.
    if (currentId(status) === journal.selectedId) {
      await this.deps.select(routeArg(status, journal.previousId));
      recordAudit({ actor: "host", eventType: "voice.network_restored", risk: "low", summary: "Restored pre-call exit node", ok: true });
    }
    unlinkSync(this.deps.journalFile);
  }
}
