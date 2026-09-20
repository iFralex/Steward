/** Transport-neutral, single-call voice coordinator for Ringback and StreamCore. */
import { randomUUID } from "node:crypto";
import { recordAudit } from "@steward/audit-log";
import type { McpBridge } from "@steward/mcp-bridge";
import type { HostConfig } from "../config.ts";
import { ChatManager, extractToolOutput, sharedMcpBridge, type TurnResult } from "./agent-runner.ts";
import { chatStore } from "./chat-store.ts";
import { Session, type Emit } from "./session.ts";
import { usageLedger, type VoiceCallRecord } from "@steward/usage-ledger";
import { parseRingbackFailure, type VoiceFailureDiagnostic } from "./voice-diagnostics.ts";

export type VoiceCallState =
  | "disabled" | "idle" | "preflighting" | "starting" | "ringing"
  | "connected" | "speaking" | "listening" | "processing" | "ending" | "failed";

export interface VoiceCallSummary {
  chatId: string;
  requestId: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  error?: string;
  failureCode?: string;
  sipStatus?: number;
  sipReason?: string;
  durationMs: number;
}

export interface VoiceChannelStatus {
  enabled: boolean;
  transport: HostConfig["voice"]["transport"];
  state: VoiceCallState;
  chatId?: string;
  requestId?: string;
  startedAt?: number;
  updatedAt: number;
  detail?: string;
  retryable?: boolean;
  lastCall?: VoiceCallSummary;
}

export interface VoiceCallStarted {
  chatId: string;
  requestId: string;
  transport: "ringback";
  state: "starting";
  duplicate?: boolean;
}

export class VoiceUnavailableError extends Error {}
export class VoiceBusyError extends Error {
  readonly retryAfterMs = 2_000;
}

interface VoiceRunner {
  runTurn(chatId: string, prompt: string): Promise<TurnResult>;
  runAutomaticTurn?(chatId: string, prompt: string): Promise<TurnResult>;
  abort(chatId?: string): Promise<void>;
}

interface VoiceCoordinatorDeps {
  bridge?: () => Promise<McpBridge>;
  createChat?: () => { id: string };
  createRunner?: (emit: Emit) => VoiceRunner;
  audit?: typeof recordAudit;
  usage?: (record: VoiceCallRecord) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface VoiceStartOptions {
  chatId?: string;
  prompt?: string;
}

const PREFLIGHT_ATTEMPTS = 2;
const IDEMPOTENCY_TTL_MS = 10 * 60_000;

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  try { return JSON.stringify(output); } catch { return String(output); }
}

class VoiceCallFailedError extends Error {
  constructor(readonly diagnostic: VoiceFailureDiagnostic) {
    super(diagnostic.message);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function ringbackCallPrompt(openingLine: string): string {
  return [
    "Avvia ora una chiamata vocale con l'utente usando mcp__voice__call_start.",
    `Pronuncia come apertura esattamente questo messaggio: ${JSON.stringify(openingLine)}.`,
    "Dopo ogni risposta dell'utente, continua la stessa chiamata con mcp__voice__converse.",
    "Parla in italiano salvo che l'utente cambi lingua; usa una o due frasi brevi per turno.",
    "Non usare ask_user durante la telefonata: fai le domande direttamente con converse.",
    "Puoi usare gli strumenti di sola lettura di Steward quando servono.",
    "Le operazioni sensibili non sono autorizzabili a voce: se ne serve una, spiega che occorre approvarla nell'app e non dichiararla eseguita.",
    "Quando l'utente saluta, riaggancia o il tool restituisce [CALL ENDED], termina con mcp__voice__call_end e concludi il turno.",
    "Se call_start restituisce [NO ANSWER] o [CALL FAILED], non riprovare: concludi il turno spiegando brevemente il problema.",
    "Non rispondere soltanto in chat: lo scopo di questo turno è svolgere la conversazione al telefono.",
  ].join(" ");
}

/** One active call per host: Ringback itself owns one process-global SIP session. */
export class VoiceCallCoordinator {
  private runner: VoiceRunner | null = null;
  private activeChatId: string | null = null;
  private activeRequestId: string | null = null;
  private startedAt: number | null = null;
  private updatedAt: number;
  private detail: string | undefined;
  private retryable: boolean | undefined;
  private terminalError: Error | null = null;
  private dialStarted = false;
  private lastCall: VoiceCallSummary | undefined;
  private state: VoiceCallState;
  private readonly idempotency = new Map<string, { result: VoiceCallStarted; expiresAt: number }>();
  private readonly deps: Required<Pick<VoiceCoordinatorDeps, "now" | "sleep">> & VoiceCoordinatorDeps;

  constructor(
    private readonly config: HostConfig,
    private readonly onFinished?: (chatId: string, error?: Error) => void | Promise<void>,
    deps: VoiceCoordinatorDeps = {},
  ) {
    this.state = config.voice.transport === "disabled" ? "disabled" : "idle";
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
    this.updatedAt = this.deps.now();
  }

  status(): VoiceChannelStatus {
    const transport = this.config.voice.transport;
    if (transport === "disabled") {
      return { enabled: false, transport, state: "disabled", updatedAt: this.updatedAt, detail: "No voice transport configured." };
    }
    if (transport === "streamcore") {
      return { enabled: false, transport, state: "disabled", updatedAt: this.updatedAt, detail: "StreamCore transport is reserved but not implemented yet." };
    }
    if (!this.config.voice.launcher) {
      return { enabled: false, transport, state: "disabled", updatedAt: this.updatedAt, detail: "STEWARD_RINGBACK_LAUNCHER is not configured." };
    }
    return {
      enabled: true,
      transport,
      state: this.state,
      updatedAt: this.updatedAt,
      ...(this.activeChatId ? { chatId: this.activeChatId } : {}),
      ...(this.activeRequestId ? { requestId: this.activeRequestId } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.retryable !== undefined ? { retryable: this.retryable } : {}),
      ...(this.lastCall ? { lastCall: this.lastCall } : {}),
    };
  }

  async start(openingLine?: string, requestedId?: string): Promise<VoiceCallStarted> {
    const suppliedId = requestedId?.trim();
    if (suppliedId) {
      this.pruneIdempotency();
      const previous = this.idempotency.get(suppliedId);
      if (previous) return { ...previous.result, duplicate: true };
    }
    return (await this.begin(openingLine, requestedId)).started;
  }

  /** Resume an existing chat for a pre-authorized automatic event and wait for
   * the whole conversational call turn to finish. */
  async runWatchEvent(chatId: string, prompt: string, requestId: string): Promise<VoiceCallSummary> {
    return (await this.begin(undefined, requestId, { chatId, prompt })).completion;
  }

  private async begin(
    openingLine?: string,
    requestedId?: string,
    options: VoiceStartOptions = {},
  ): Promise<{ started: VoiceCallStarted; completion: Promise<VoiceCallSummary> }> {
    if (this.config.voice.transport !== "ringback" || !this.config.voice.launcher) {
      throw new VoiceUnavailableError(this.status().detail ?? "Voice calls are unavailable.");
    }
    const requestId = requestedId?.trim() || randomUUID();
    this.pruneIdempotency();
    const previous = this.idempotency.get(requestId);
    if (previous) throw new VoiceBusyError("This voice event was already started.");
    if (this.activeChatId || this.activeRequestId) throw new VoiceBusyError("A voice call is already running.");

    this.activeRequestId = requestId;
    this.startedAt = this.deps.now();
    this.terminalError = null;
    this.dialStarted = false;
    this.transition("preflighting", "Checking the Ringback engine before dialing.");
    try {
      await this.preflight();
      this.audit({
        actor: "host", eventType: "voice.preflight_passed", risk: "low", summary: "Ringback preflight passed",
        correlationId: requestId, ok: true, payload: { transport: "ringback" },
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.audit({
        actor: "host", eventType: "voice.preflight_failed", risk: "medium", summary: error.message,
        correlationId: requestId, ok: false, payload: { transport: "ringback", error: error.message },
      });
      this.failBeforeCall(error);
      throw new VoiceUnavailableError(error.message);
    }

    const line = (openingLine?.trim() || this.config.voice.openingLine).slice(0, 500);
    const chat = options.chatId
      ? { id: options.chatId }
      : (this.deps.createChat ?? (() => chatStore().createChat("Chiamata vocale")))();
    if (options.chatId && !chatStore().exists(options.chatId)) {
      const error = new Error(`Chat not found: ${options.chatId}`);
      this.failBeforeCall(error);
      throw new VoiceUnavailableError(error.message);
    }
    this.activeChatId = chat.id;
    this.transition("starting", "Ringback is ready; Steward is preparing the call.");
    this.audit({
      actor: options.chatId ? "scheduler" : "user", eventType: "voice.call_requested", risk: "medium",
      summary: options.chatId ? "Pre-authorized watch event requested a voice call" : "Voice call requested",
      chatId: chat.id, correlationId: requestId,
      payload: { transport: "ringback", requestId, ...(options.chatId ? { automatic: true } : { openingLine: line }) },
    });

    const started: VoiceCallStarted = { chatId: chat.id, requestId, transport: "ringback", state: "starting" };
    this.idempotency.set(requestId, { result: started, expiresAt: this.deps.now() + IDEMPOTENCY_TTL_MS });
    let complete!: (summary: VoiceCallSummary) => void;
    const completion = new Promise<VoiceCallSummary>((resolve) => { complete = resolve; });
    let completedSummary: VoiceCallSummary | undefined;
    const runner = this.getRunner();
    const turnPrompt = options.prompt ?? ringbackCallPrompt(line);
    const turn = options.chatId && runner.runAutomaticTurn
      ? runner.runAutomaticTurn(chat.id, turnPrompt)
      : runner.runTurn(chat.id, turnPrompt);
    void turn.then(async (result) => {
      if (!result.ok) throw new Error(result.error || "The voice agent turn failed.");
      if (this.terminalError) throw this.terminalError;
      if (!this.dialStarted) throw new Error("The automatic voice turn completed without starting a call.");
      this.audit({
        actor: "host", eventType: "voice.call_completed", risk: "low", summary: "Voice call completed",
        chatId: chat.id, correlationId: requestId, ok: true,
        durationMs: this.callDurationMs(), payload: { transport: "ringback", requestId },
      });
      const summary = this.finish(chat.id, requestId);
      completedSummary = summary;
      if (!options.chatId) {
        try { await this.onFinished?.(chat.id); } catch { /* completion callback is best-effort */ }
      }
    }).catch(async (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const diagnostic = error instanceof VoiceCallFailedError ? error.diagnostic : undefined;
      this.transition("failed", error.message, diagnostic?.retryable ?? true);
      this.audit({
        actor: "host", eventType: "voice.call_failed", risk: "medium", summary: error.message,
        chatId: chat.id, correlationId: requestId, ok: false,
        durationMs: this.callDurationMs(),
        payload: { transport: "ringback", requestId, error: error.message, ...(diagnostic ? { diagnostic } : {}) },
      });
      const summary = this.finish(chat.id, requestId, error);
      completedSummary = summary;
      if (!options.chatId) {
        try { await this.onFinished?.(chat.id, error); } catch { /* completion callback is best-effort */ }
      }
    }).finally(() => {
      if (this.activeChatId === chat.id) {
        this.activeChatId = null;
        this.activeRequestId = null;
        this.startedAt = null;
        this.transition("idle", this.lastCall?.ok ? "The last call completed." : "The last call failed.", !this.lastCall?.ok);
      }
      if (completedSummary) complete(completedSummary);
    });
    return { started, completion };
  }

  private async preflight(): Promise<void> {
    const timeoutMs = this.config.voice.transport === "ringback" ? this.config.voice.preflightTimeoutMs : 10_000;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt += 1) {
      try {
        const bridge = await withTimeout((this.deps.bridge ?? (() => sharedMcpBridge(this.config.mcpServers)))(), timeoutMs, "Ringback MCP startup");
        const required = ["mcp__voice__call_start", "mcp__voice__call_status", "mcp__voice__call_end"];
        const missing = required.filter((name) => !bridge.tools.some((tool) => tool.name === name));
        if (missing.length) throw new Error(`Ringback is missing required tools: ${missing.join(", ")}`);
        const health = await withTimeout(bridge.callTool("mcp__voice__call_status", {}), timeoutMs, "Ringback health check");
        // McpBridge.callTool returns the bare MCP content array, whereas tool
        // events carry { content }. Normalize both forms before parsing JSON.
        const healthOutput = extractToolOutput(Array.isArray(health) ? { content: health } : health);
        const healthText = outputText(healthOutput);
        if (/"ready"\s*:\s*false/i.test(healthText)) throw new Error(`Ringback is not ready: ${healthText}`);
        this.transition("starting", "Ringback preflight passed.");
        return;
      } catch (cause) {
        lastError = cause instanceof Error ? cause : new Error(String(cause));
        if (attempt < PREFLIGHT_ATTEMPTS) {
          this.transition("preflighting", `Ringback preflight attempt ${attempt} failed; retrying safely.`);
          await this.deps.sleep(250);
        }
      }
    }
    throw lastError ?? new Error("Ringback preflight failed.");
  }

  private onAgentEvent: Emit = (event) => {
    const e = event as unknown as { type?: string; tool?: string; ok?: boolean; output?: unknown };
    if (e.type === "tool_call") {
      if (e.tool === "mcp__voice__call_start") {
        this.dialStarted = true;
        this.transition("ringing", "Calling the phone; waiting for an answer.");
      }
      else if (e.tool === "mcp__voice__converse" || e.tool === "mcp__voice__speak") this.transition("speaking", "Steward is speaking and waiting for the next reply.");
      else if (e.tool === "mcp__voice__listen") this.transition("listening", "Steward is listening.");
      else if (e.tool === "mcp__voice__call_end") this.transition("ending", "Steward is ending the call.");
      else if (this.activeChatId) this.transition("processing", "Steward is processing the request.");
      return;
    }
    if (e.type !== "tool_result" || !e.tool?.startsWith("mcp__voice__")) return;
    const failure = parseRingbackFailure(e.output);
    if (failure) {
      this.terminalError = new VoiceCallFailedError(failure);
      this.transition("failed", failure.message, failure.retryable);
      return;
    }
    if (e.ok === false) {
      this.terminalError = new Error(`Ringback tool failed: ${e.tool}`);
      this.transition("failed", this.terminalError.message, true);
      return;
    }
    const text = outputText(e.output);
    if (text.includes("[CALL ENDED]") || e.tool === "mcp__voice__call_end") this.transition("ending", "The phone call has ended.");
    else this.transition("processing", "Steward received the reply and is processing it.");
  };

  private failBeforeCall(error: Error): void {
    this.transition("failed", error.message, true);
    this.activeRequestId = null;
    this.startedAt = null;
  }

  private finish(chatId: string, requestId: string, error?: Error): VoiceCallSummary {
    const diagnostic = error instanceof VoiceCallFailedError ? error.diagnostic : undefined;
    const finishedAt = this.deps.now();
    const startedAt = this.startedAt ?? finishedAt;
    const durationMs = Math.max(0, finishedAt - startedAt);
    const summary: VoiceCallSummary = {
      chatId, requestId, startedAt, finishedAt, durationMs, ok: !error,
      ...(error ? { error: error.message } : {}),
      ...(diagnostic?.code ? { failureCode: diagnostic.code } : {}),
      ...(diagnostic?.sipStatus !== undefined ? { sipStatus: diagnostic.sipStatus } : {}),
      ...(diagnostic?.sipReason ? { sipReason: diagnostic.sipReason } : {}),
    };
    this.lastCall = summary;
    try {
      const record: VoiceCallRecord = {
        ts: finishedAt, sessionId: chatId, transport: "ringback",
        outcome: error ? (diagnostic?.code ?? "unknown") : "completed",
        failureCode: diagnostic?.code, sipStatus: diagnostic?.sipStatus, durationMs, ok: !error,
      };
      (this.deps.usage ?? ((entry) => usageLedger().recordVoiceCall(entry)))(record);
    } catch { /* usage is best-effort */ }
    return summary;
  }

  private callDurationMs(): number {
    return Math.max(0, this.deps.now() - (this.startedAt ?? this.deps.now()));
  }

  private transition(state: VoiceCallState, detail?: string, retryable?: boolean): void {
    this.state = state;
    this.detail = detail;
    this.retryable = retryable;
    this.updatedAt = this.deps.now();
  }

  private pruneIdempotency(): void {
    const now = this.deps.now();
    for (const [key, entry] of this.idempotency) if (entry.expiresAt <= now) this.idempotency.delete(key);
  }

  private audit(input: Parameters<typeof recordAudit>[0]): void {
    (this.deps.audit ?? recordAudit)(input);
  }

  private getRunner(): VoiceRunner {
    if (this.runner) return this.runner;
    if (this.deps.createRunner) {
      this.runner = this.deps.createRunner(this.onAgentEvent);
      return this.runner;
    }
    const voiceConfig: HostConfig = {
      ...this.config,
      gateway: { ...this.config.gateway, usageService: "host", usageAction: "voice-call" },
      policy: {
        ...this.config.policy,
        default: "deny",
        rules: { ...this.config.policy.rules, "mcp__voice__call_start": "allow" },
      },
    };
    const session = new Session(this.onAgentEvent, this.config.approvalTimeoutMs);
    this.runner = new ChatManager(voiceConfig, session, this.onAgentEvent);
    return this.runner;
  }
}
