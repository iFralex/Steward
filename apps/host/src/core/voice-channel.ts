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
import { getUserLang } from "./notification-lang.ts";
import { localizedOpeningLine, voiceMessages, type VoiceLang } from "./voice-i18n.ts";
import { clearCallVoiceOverride } from "./voice-settings.ts";
import { buildVoiceSettingsTool } from "./voice-settings-tool.ts";

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
  runAutomaticTurn?(chatId: string, prompt: string, actor?: "scheduler" | "host"): Promise<TurnResult>;
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
  language?: () => VoiceLang;
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

function jsonForSpeech(value: unknown, lang: VoiceLang): string {
  if (value === undefined) return voiceMessages(lang).undefinedValue;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Deterministic rendering of exactly what the permission gate is waiting on. */
export function formatVoiceApprovalRequest(
  request: Pick<VoiceApprovalEvent, "tool" | "input" | "preview">,
  lang: VoiceLang = "en",
): string {
  const copy = voiceMessages(lang).approval;
  const parts = [
    copy.title,
    copy.tool(request.tool),
    copy.arguments(jsonForSpeech(request.input, lang)),
  ];
  if (request.preview !== undefined) parts.push(copy.preview(jsonForSpeech(request.preview, lang)));
  parts.push(copy.instruction);
  return parts.join(" ");
}

function userReply(output: unknown): string {
  const text = outputText(output);
  const wrapped = text.match(/User replied:\s*["“]([\s\S]*?)["”]\s*$/i);
  return (wrapped?.[1] ?? text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function parseVoiceApprovalReply(
  output: unknown,
  lang: VoiceLang = "en",
): VoiceApprovalDecision | "repeat" | "unknown" {
  const reply = userReply(output);
  const keywords = voiceMessages(lang).approval.keywords;
  if (keywords.allow.includes(reply)) return "allow";
  if (keywords.deny.includes(reply)) return "deny";
  if (keywords.repeat.includes(reply)) return "repeat";
  return "unknown";
}

/** Runs outside the model so the agent cannot interpret its own authorization. */
export async function conductVoiceApproval(
  prompt: string,
  converse: (text: string) => Promise<unknown>,
  lang: VoiceLang = "en",
  onRepeat?: () => void,
): Promise<{ decision: VoiceApprovalDecision; repeats: number; reason: string }> {
  let next = prompt;
  let repeats = 0;
  for (let exchange = 0; exchange < MAX_APPROVAL_EXCHANGES; exchange += 1) {
    const parsed = parseVoiceApprovalReply(await converse(next), lang);
    if (parsed === "allow" || parsed === "deny") return { decision: parsed, repeats, reason: "spoken-command" };
    if (parsed === "repeat") {
      repeats += 1;
      onRepeat?.();
      next = prompt;
      continue;
    }
    next = voiceMessages(lang).approval.notUnderstood;
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

export function ringbackCallPrompt(openingLine: string, lang: VoiceLang = "en"): string {
  return voiceMessages(lang).callPrompt(openingLine);
}

/** One active call per host: Ringback itself owns one process-global SIP session. */
export class VoiceCallCoordinator {
  private runner: VoiceRunner | null = null;
  private runnerSession: Session | null = null;
  private activeApprovalSession: Session | null = null;
  private approvalQueue: Promise<void> = Promise.resolve();
  private activeLanguage: VoiceLang | null = null;
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
    const copy = voiceMessages(this.currentLanguage()).status;
    if (transport === "disabled") {
      return { enabled: false, transport, state: "disabled", updatedAt: this.updatedAt, detail: copy.noTransport };
    }
    if (transport === "streamcore") {
      return { enabled: false, transport, state: "disabled", updatedAt: this.updatedAt, detail: copy.streamcoreUnavailable };
    }
    if (!this.config.voice.launcher) {
      return { enabled: false, transport, state: "disabled", updatedAt: this.updatedAt, detail: copy.launcherMissing };
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
      throw new VoiceUnavailableError(this.status().detail ?? voiceMessages(this.currentLanguage()).status.unavailable);
    }
    const requestId = requestedId?.trim() || randomUUID();
    this.pruneIdempotency();
    const previous = this.idempotency.get(requestId);
    if (previous) throw new VoiceBusyError(voiceMessages(this.currentLanguage()).status.duplicate);
    if (this.activeChatId || this.activeRequestId) throw new VoiceBusyError(voiceMessages(this.currentLanguage()).status.busy);

    const language = this.currentLanguage();
    const voiceCopy = voiceMessages(language);
    this.activeLanguage = language;
    clearCallVoiceOverride();
    this.activeRequestId = requestId;
    this.startedAt = this.deps.now();
    this.terminalError = null;
    this.dialStarted = false;
    this.transition("preflighting", voiceCopy.status.checking);
    try {
      await this.preflight();
      this.audit({
        actor: "host", eventType: "voice.preflight_passed", risk: "low", summary: voiceCopy.status.preflightPassed,
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

    const line = localizedOpeningLine(openingLine?.trim() || this.config.voice.openingLine, language).slice(0, 500);
    const chat = options.chatId
      ? { id: options.chatId }
      : (this.deps.createChat ?? (() => chatStore().createChat(voiceMessages(language).chatTitle)))();
    if (options.chatId && !chatStore().exists(options.chatId)) {
      const error = new Error(`Chat not found: ${options.chatId}`);
      this.failBeforeCall(error);
      throw new VoiceUnavailableError(error.message);
    }
    this.activeChatId = chat.id;
    this.transition("starting", voiceCopy.status.preparing);
    this.audit({
      actor: options.chatId ? "scheduler" : "user", eventType: "voice.call_requested", risk: "medium",
      summary: options.chatId ? voiceCopy.audit.watchCallRequested : voiceCopy.audit.callRequested,
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
    const turnPrompt = options.prompt ?? ringbackCallPrompt(line, language);
    const turn = runner.runAutomaticTurn
      ? runner.runAutomaticTurn(chat.id, turnPrompt, options.chatId ? "scheduler" : "host")
      : runner.runTurn(chat.id, turnPrompt);
    void turn.then(async (result) => {
      if (!result.ok) throw new Error(result.error || voiceCopy.status.agentFailed);
      if (this.terminalError) throw this.terminalError;
      if (!this.dialStarted) throw new Error(voiceCopy.status.noDial);
      this.audit({
        actor: "host", eventType: "voice.call_completed", risk: "low", summary: voiceCopy.audit.callCompleted,
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
      clearCallVoiceOverride();
      if (this.activeChatId === chat.id) {
        if (this.activeApprovalSession === callApprovalSession) this.activeApprovalSession = null;
        this.activeLanguage = null;
        this.activeChatId = null;
        this.activeRequestId = null;
        this.startedAt = null;
        this.transition("idle", this.lastCall?.ok ? voiceCopy.status.lastCompleted : voiceCopy.status.lastFailed, !this.lastCall?.ok);
      }
      if (completedSummary) complete(completedSummary);
    });
    return { started, completion };
  }

  private async preflight(): Promise<void> {
    const copy = voiceMessages(this.currentLanguage()).status;
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
        this.transition("starting", copy.preflightPassed);
        return;
      } catch (cause) {
        lastError = cause instanceof Error ? cause : new Error(String(cause));
        if (attempt < PREFLIGHT_ATTEMPTS) {
          this.transition("preflighting", copy.preflightRetrying(attempt));
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
          summary: voiceMessages(this.currentLanguage()).status.approvalNoSession, chatId: event.chatId,
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
      const copy = voiceMessages(this.currentLanguage()).status;
      if (e.tool === "mcp__voice__call_start") {
        this.dialStarted = true;
        this.transition("ringing", copy.ringing);
      }
      else if (e.tool === "mcp__voice__converse" || e.tool === "mcp__voice__speak") this.transition("speaking", copy.speaking);
      else if (e.tool === "mcp__voice__listen") this.transition("listening", copy.listening);
      else if (e.tool === "mcp__voice__call_end") this.transition("ending", copy.ending);
      else if (this.activeChatId) this.transition("processing", copy.processing);
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
    const copy = voiceMessages(this.currentLanguage()).status;
    if (text.includes("[CALL ENDED]") || e.tool === "mcp__voice__call_end") this.transition("ending", copy.callEnded);
    else this.transition("processing", copy.replyReceived);
  };

  private failBeforeCall(error: Error): void {
    this.transition("failed", error.message, true);
    this.activeLanguage = null;
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

  private currentLanguage(): VoiceLang {
    return this.activeLanguage ?? (this.deps.language ?? getUserLang)();
  }

  private async handleVoiceApproval(request: VoiceApprovalEvent, session: Session): Promise<void> {
    const startedAt = this.deps.now();
    const language = this.activeLanguage ?? (this.deps.language ?? getUserLang)();
    const copy = voiceMessages(language).approval;
    const prompt = formatVoiceApprovalRequest(request, language);
    this.transition("speaking", copy.readingStatus(request.tool));
    this.audit({
      actor: "host", eventType: "voice.approval_prompted", risk: "high",
      summary: voiceMessages(language).audit.approvalRequested(request.tool), sessionId: session.id,
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
          this.transition("listening", copy.waitingStatus);
          const raw = await bridge.callTool("mcp__voice__converse", { text });
          return extractToolOutput(Array.isArray(raw) ? { content: raw } : raw);
        },
        language,
        () => {
          this.audit({
            actor: "user", eventType: "voice.approval_repeated", risk: "high",
            summary: voiceMessages(language).audit.approvalRepeated(request.tool), sessionId: session.id,
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
      ...(decision === "deny" ? { note: copy.deniedNote(reason) } : {}),
    });
    const durationMs = Math.max(0, this.deps.now() - startedAt);
    this.audit({
      actor: "user", eventType: `voice.approval_${decision}`, risk: "high",
      summary: voiceMessages(language).audit.approvalDecision(decision, request.tool), sessionId: session.id,
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
    this.transition("processing", resolved ? copy.recordedStatus(decision) : copy.alreadyResolvedStatus);
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
    this.runner = new ChatManager(
      voiceConfig, session, this.onAgentEvent, undefined,
      (chatId) => [buildVoiceSettingsTool(session, chatId, this.activeLanguage ?? this.currentLanguage())],
    );
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
    return new ChatManager(
      voiceConfig, session, this.onAgentEvent, executionGuard,
      (chatId) => [buildVoiceSettingsTool(session, chatId, this.activeLanguage ?? this.currentLanguage())],
    );
  }
}
