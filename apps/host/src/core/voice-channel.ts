/** Transport-neutral, single-call voice coordinator for Ringback and StreamCore. */
import { randomUUID } from "node:crypto";
import { recordAudit } from "@steward/audit-log";
import type { McpBridge } from "@steward/mcp-bridge";
import type { ServerEvent } from "@steward/protocol";
import type { HostConfig } from "../config.ts";
import { ChatManager, extractToolOutput, sharedMcpBridge, type TurnResult } from "./agent-runner.ts";
import { chatStore } from "./chat-store.ts";
import { Session, type Emit } from "./session.ts";
import { usageLedger, type ToolCallRecord, type VoiceCallRecord } from "@steward/usage-ledger";
import { parseRingbackFailure, type VoiceFailureDiagnostic } from "./voice-diagnostics.ts";
import type { ToolExecutionGuard } from "./permission-gate.ts";
import type { ToolPolicy } from "./tool-policy.ts";

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
  close?(): Promise<void>;
}

interface VoiceCoordinatorDeps {
  bridge?: () => Promise<McpBridge>;
  createChat?: () => { id: string };
  createRunner?: (
    emit: Emit,
    scope?: { allowedTools: string[]; executionGuard?: ToolExecutionGuard },
    session?: Session,
  ) => VoiceRunner;
  audit?: typeof recordAudit;
  usage?: (record: VoiceCallRecord) => void;
  toolUsage?: (record: ToolCallRecord) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface VoiceStartOptions {
  chatId?: string;
  prompt?: string;
  allowedTools?: string[];
  executionGuard?: ToolExecutionGuard;
}

const PREFLIGHT_ATTEMPTS = 2;
const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const MAX_APPROVAL_EXCHANGES = 6;

type VoiceApprovalEvent = Extract<ServerEvent, { type: "approval_request" }>;
export type VoiceApprovalDecision = "allow" | "deny";

function jsonForSpeech(value: unknown): string {
  if (value === undefined) return "nessuno";
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Deterministic rendering of exactly what the permission gate is waiting on. */
export function formatVoiceApprovalRequest(request: Pick<VoiceApprovalEvent, "tool" | "input" | "preview">): string {
  const parts = [
    "Richiesta di approvazione.",
    `Strumento: ${request.tool}.`,
    `Argomenti: ${jsonForSpeech(request.input)}.`,
  ];
  if (request.preview !== undefined) parts.push(`Anteprima: ${jsonForSpeech(request.preview)}.`);
  parts.push("Di approva per eseguirla, rifiuta per negarla, oppure ripeti per riascoltare questa richiesta.");
  return parts.join(" ");
}

function userReply(output: unknown): string {
  const text = outputText(output);
  const wrapped = text.match(/User replied:\s*["“]([\s\S]*?)["”]\s*$/i);
  return (wrapped?.[1] ?? text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("it")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function parseVoiceApprovalReply(output: unknown): VoiceApprovalDecision | "repeat" | "unknown" {
  const reply = userReply(output);
  if (reply === "approva") return "allow";
  if (reply === "rifiuta") return "deny";
  if (["ripeti", "ripetilo", "rileggi", "rileggi la richiesta"].includes(reply)) return "repeat";
  return "unknown";
}

/** Runs outside the model so the agent cannot interpret its own authorization. */
export async function conductVoiceApproval(
  prompt: string,
  converse: (text: string) => Promise<unknown>,
  onRepeat?: () => void,
): Promise<{ decision: VoiceApprovalDecision; repeats: number; reason: string }> {
  let next = prompt;
  let repeats = 0;
  for (let exchange = 0; exchange < MAX_APPROVAL_EXCHANGES; exchange += 1) {
    const parsed = parseVoiceApprovalReply(await converse(next));
    if (parsed === "allow" || parsed === "deny") return { decision: parsed, repeats, reason: "spoken-command" };
    if (parsed === "repeat") {
      repeats += 1;
      onRepeat?.();
      next = prompt;
      continue;
    }
    next = "Non ho capito. Di soltanto approva, rifiuta oppure ripeti.";
  }
  return { decision: "deny", repeats, reason: "unrecognized-or-too-many-attempts" };
}

/** The call has the PWA policy, plus call-start and any watch-scoped grants. */
export function voiceToolPolicy(policy: ToolPolicy, allowedTools: string[] = []): ToolPolicy {
  return {
    ...policy,
    rules: Object.fromEntries([
      ...Object.entries(policy.rules),
      ["mcp__voice__call_start", "allow"],
      ...allowedTools.map((tool) => [tool, "allow"]),
    ]) as ToolPolicy["rules"],
  };
}

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
    "Le operazioni sensibili attivano il sottoprotocollo vocale dell'host: attendi la decisione senza chiederla o interpretarla tu e non dichiarare eseguita un'azione negata.",
    "Quando l'utente saluta, riaggancia o il tool restituisce [CALL ENDED], termina con mcp__voice__call_end e concludi il turno.",
    "Se call_start restituisce [NO ANSWER] o [CALL FAILED], non riprovare: concludi il turno spiegando brevemente il problema.",
    "Non rispondere soltanto in chat: lo scopo di questo turno è svolgere la conversazione al telefono.",
  ].join(" ");
}

/** One active call per host: Ringback itself owns one process-global SIP session. */
export class VoiceCallCoordinator {
  private runner: VoiceRunner | null = null;
  private runnerSession: Session | null = null;
  private activeApprovalSession: Session | null = null;
  private approvalQueue: Promise<void> = Promise.resolve();
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
  async runWatchEvent(
    chatId: string,
    prompt: string,
    requestId: string,
    scope?: { allowedTools?: string[]; executionGuard?: ToolExecutionGuard },
  ): Promise<VoiceCallSummary> {
    return (await this.begin(undefined, requestId, { chatId, prompt, ...scope })).completion;
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
    const scoped = !!(options.allowedTools?.length || options.executionGuard);
    const runner = scoped ? this.createScopedRunner(options.allowedTools ?? [], options.executionGuard) : this.getRunner();
    const callApprovalSession = this.activeApprovalSession;
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
    }).finally(async () => {
      if (scoped) await runner.close?.();
      if (scoped && callApprovalSession) callApprovalSession.closed = true;
      if (this.activeChatId === chat.id) {
        if (this.activeApprovalSession === callApprovalSession) this.activeApprovalSession = null;
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
    if (event.type === "approval_request") {
      const session = this.activeApprovalSession;
      if (!session) {
        this.audit({
          actor: "host", eventType: "voice.approval_failed", risk: "high",
          summary: "Voice approval has no active session", chatId: event.chatId,
          toolName: event.tool, correlationId: event.requestId, ok: false,
        });
        return;
      }
      this.approvalQueue = this.approvalQueue
        .then(() => this.handleVoiceApproval(event, session))
        .catch(() => { /* handleVoiceApproval fails closed and records the error */ });
      return;
    }
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

  private async handleVoiceApproval(request: VoiceApprovalEvent, session: Session): Promise<void> {
    const startedAt = this.deps.now();
    const prompt = formatVoiceApprovalRequest(request);
    this.transition("speaking", `Steward is reading the approval request for ${request.tool}.`);
    this.audit({
      actor: "host", eventType: "voice.approval_prompted", risk: "high",
      summary: `Voice approval requested for ${request.tool}`, sessionId: session.id,
      chatId: request.chatId, toolName: request.tool, correlationId: request.requestId,
      payload: { input: request.input, preview: request.preview },
    });
    let decision: VoiceApprovalDecision = "deny";
    let repeats = 0;
    let reason = "voice-approval-error";
    try {
      const bridge = await (this.deps.bridge ?? (() => sharedMcpBridge(this.config.mcpServers)))();
      const result = await conductVoiceApproval(
        prompt,
        async (text) => {
          this.transition("listening", "Steward is waiting for approva, rifiuta, or ripeti.");
          const raw = await bridge.callTool("mcp__voice__converse", { text });
          return extractToolOutput(Array.isArray(raw) ? { content: raw } : raw);
        },
        () => {
          this.audit({
            actor: "user", eventType: "voice.approval_repeated", risk: "high",
            summary: `Voice approval request repeated for ${request.tool}`, sessionId: session.id,
            chatId: request.chatId, toolName: request.tool, correlationId: request.requestId, ok: true,
          });
        },
      );
      decision = result.decision;
      repeats = result.repeats;
      reason = result.reason;
    } catch (cause) {
      reason = cause instanceof Error ? cause.message : String(cause);
      decision = "deny";
    }

    const resolved = session.resolveApproval(request.requestId, {
      decision,
      ...(decision === "deny" ? { note: `Rifiutata durante la chiamata: ${reason}` } : {}),
    });
    const durationMs = Math.max(0, this.deps.now() - startedAt);
    this.audit({
      actor: "user", eventType: `voice.approval_${decision}`, risk: "high",
      summary: `Voice approval ${decision} for ${request.tool}`, sessionId: session.id,
      chatId: request.chatId, toolName: request.tool, correlationId: request.requestId,
      durationMs, ok: decision === "allow" && resolved,
      payload: { decision, repeats, reason, resolved },
    });
    try {
      const usage: ToolCallRecord = {
        ts: this.deps.now(), sessionId: request.chatId ?? session.id,
        tool: "voice.approval", durationMs, ok: resolved && reason === "spoken-command",
      };
      (this.deps.toolUsage ?? ((entry) => usageLedger().recordTool(entry)))(usage);
    } catch { /* usage is best-effort */ }
    this.transition("processing", resolved ? `Voice approval ${decision} recorded.` : "The approval was already resolved.");
  }

  private getRunner(): VoiceRunner {
    if (this.runner) {
      this.activeApprovalSession = this.runnerSession;
      return this.runner;
    }
    if (this.deps.createRunner) {
      const session = new Session(this.onAgentEvent, this.config.approvalTimeoutMs);
      this.runnerSession = session;
      this.activeApprovalSession = session;
      this.runner = this.deps.createRunner(this.onAgentEvent, undefined, session);
      return this.runner;
    }
    const voiceConfig: HostConfig = {
      ...this.config,
      gateway: { ...this.config.gateway, usageService: "host", usageAction: "voice-call" },
      policy: voiceToolPolicy(this.config.policy),
    };
    const session = new Session(this.onAgentEvent, this.config.approvalTimeoutMs);
    this.runnerSession = session;
    this.activeApprovalSession = session;
    this.runner = new ChatManager(voiceConfig, session, this.onAgentEvent);
    return this.runner;
  }

  private createScopedRunner(allowedTools: string[], executionGuard?: ToolExecutionGuard): VoiceRunner {
    if (this.deps.createRunner) {
      const session = new Session(this.onAgentEvent, this.config.approvalTimeoutMs);
      this.activeApprovalSession = session;
      return this.deps.createRunner(this.onAgentEvent, { allowedTools, executionGuard }, session);
    }
    const voiceConfig: HostConfig = {
      ...this.config,
      gateway: { ...this.config.gateway, usageService: "host", usageAction: "voice-call" },
      policy: voiceToolPolicy(this.config.policy, allowedTools),
    };
    const session = new Session(this.onAgentEvent, this.config.approvalTimeoutMs);
    this.activeApprovalSession = session;
    return new ChatManager(voiceConfig, session, this.onAgentEvent, executionGuard);
  }
}
