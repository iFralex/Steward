/**
 * Multi-chat agent runner. One ChatManager per channel connection uses the
 * single process-wide MCP bridge (the heavy part, see {@link sharedMcpBridge})
 * and owns one Pi AgentSession per chat — each with its own file-backed memory
 * (persisted by Pi) and its own usage stats. Switching chats swaps the live
 * session, not the bridge, so it's instant. Every turn's transcript
 * (user / assistant / tool) is persisted to chat-store so conversations
 * survive reloads and host restarts.
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { buildMcpBridge, type McpBridge } from "@steward/mcp-bridge";
import { recordAudit } from "@steward/audit-log";
import { gateToolDefinition } from "./permission-gate.ts";
import { buildAskUserTool } from "./ask-user-tool.ts";
import { buildClipboardTool } from "./clipboard-tool.ts";
import { filesFromOutput } from "./file-registry.ts";
import { registerGatewayModel } from "./pi-provider.ts";
import { chatStore, toolMessage } from "./chat-store.ts";
import { markIdle, markRunning } from "./running-chats.ts";
import { usageLedger } from "@steward/usage-ledger";
import type { Emit, Session } from "./session.ts";
import type { HostConfig } from "../config.ts";
import type { ChannelFile } from "@steward/protocol";

let sharedBridge: Promise<McpBridge> | undefined;
/** One set of MCP connector child processes for the whole host process. Built
 *  lazily and kept for the process lifetime — never closed per-connection, since
 *  closing it would tear down connectors other chats/connections still use.
 *  A failed build is not cached, so a transient failure can be retried. */
export function sharedMcpBridge(specs: Parameters<typeof buildMcpBridge>[0]): Promise<McpBridge> {
  return (sharedBridge ??= buildMcpBridge(specs).catch((err) => {
    sharedBridge = undefined; // don't poison the process with a cached rejection
    throw err;
  }));
}

/**
 * Turn Pi's tool result into a UI-friendly `output`: pull the text out of the
 * `{ content: [{ text }] }` shape and parse it as JSON when the tool returned
 * JSON (our MCP tools do), otherwise keep the raw string.
 */
export function extractToolOutput(result: unknown): unknown {
  const content = (result as { content?: unknown })?.content;
  let text = "";
  if (Array.isArray(content)) {
    text = content.map((c) => (typeof (c as { text?: unknown })?.text === "string" ? (c as { text: string }).text : "")).join("");
  } else if (typeof result === "string") {
    text = result;
  }
  if (!text) return result ?? null;
  const trimmed = text.trim();
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try { return JSON.parse(trimmed); } catch { /* not JSON, fall through */ }
  }
  return text;
}

/** Serialize turns per chat: a second user message waits for the first to finish. */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    this.tails.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}

export interface PiRuntime {
  session: AgentSession;
  bridge: McpBridge;
  close(): Promise<void>;
}

/**
 * Build a single standalone Pi runtime (one bridge + one in-memory session).
 * Used by tests / one-off callers; production uses {@link ChatManager}, which
 * shares one bridge across many file-backed chat sessions.
 */
export async function buildPiRuntime(config: HostConfig, hostSession: Session): Promise<PiRuntime> {
  const { modelRegistry, model } = registerGatewayModel(config.gateway);
  const bridge = await buildMcpBridge(config.mcpServers);
  let piSession: AgentSession;
  const tools = [
    ...bridge.tools.map((def) =>
      gateToolDefinition(
        def,
        config.policy,
        hostSession.requestApproval,
        () => ({ followUp: (t: string) => piSession.followUp(t) }),
        () => ({ sessionId: hostSession.id }),
      ),
    ),
    gateToolDefinition(
      buildClipboardTool(),
      config.policy,
      hostSession.requestApproval,
      () => ({ followUp: (t: string) => piSession.followUp(t) }),
      () => ({ sessionId: hostSession.id }),
    ),
    buildAskUserTool(hostSession.askQuestion),
  ];
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir: process.cwd(),
    systemPromptOverride: () => config.systemPrompt,
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true,
  });
  await resourceLoader.reload();
  let created;
  try {
    created = await createAgentSession({
      model, modelRegistry, resourceLoader,
      sessionManager: SessionManager.inMemory(), noTools: "builtin", customTools: tools,
    });
  } catch (err) {
    await bridge.close();
    throw err;
  }
  piSession = created.session;
  return { session: piSession, bridge, close: async () => { piSession.dispose(); await bridge.close(); } };
}

interface BridgeRuntime {
  bridge: McpBridge;
  modelRegistry: ReturnType<typeof registerGatewayModel>["modelRegistry"];
  model: ReturnType<typeof registerGatewayModel>["model"];
  resourceLoader: DefaultResourceLoader;
}

interface ChatRuntime {
  chatId: string;
  session: AgentSession;
  unsub: () => void;
  lastCostUsd: number;
  lastTokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Assistant text accumulated since the last flush point (flushed to transcript at
   * each tool-call boundary, and once more when the turn ends). */
  assistantBuffer: string;
  /** Set while a user-requested stop is in flight, to suppress the abort error. */
  aborted: boolean;
  /** toolCallId → start time (for durations) and input (for the transcript). */
  starts: Map<string, number>;
  toolInputs: Map<string, unknown>;
}

export class ChatManager {
  private bridge?: BridgeRuntime;
  private readonly chats = new Map<string, ChatRuntime>();
  private readonly turnQueue = new KeyedQueue();

  constructor(
    private readonly config: HostConfig,
    private readonly session: Session,
    private readonly emit: Emit,
  ) {}

  private async ensureBridge(): Promise<BridgeRuntime> {
    if (this.bridge) return this.bridge;
    const { modelRegistry, model } = registerGatewayModel(this.config.gateway);
    const bridge = await sharedMcpBridge(this.config.mcpServers);
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      systemPromptOverride: () => this.config.systemPrompt,
      noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true,
    });
    await resourceLoader.reload();
    this.bridge = { bridge, modelRegistry, model, resourceLoader };
    return this.bridge;
  }

  /** Build (or reopen) the Pi session for a chat, restoring memory from its file. */
  private async ensureChat(chatId: string): Promise<ChatRuntime> {
    const existing = this.chats.get(chatId);
    if (existing) return existing;
    const b = await this.ensureBridge();
    const store = chatStore();

    const file = store.getSessionFile(chatId);
    let sessionManager: SessionManager;
    if (file && existsSync(file)) {
      try {
        sessionManager = SessionManager.open(file, store.sessionDir);
      } catch {
        sessionManager = SessionManager.create(process.cwd(), store.sessionDir);
        store.setSessionFile(chatId, sessionManager.getSessionFile() ?? file);
      }
    } else {
      sessionManager = SessionManager.create(process.cwd(), store.sessionDir);
      const created = sessionManager.getSessionFile();
      if (created) store.setSessionFile(chatId, created);
    }

    // Built per chat (not shared): each chat's gate closes over its own chatId
    // (so approval cards route to the right chat) and its own piSession
    // followUp sink (so an allow-note lands on the chat that asked, not
    // whichever chat happens to be running).
    let piSession: AgentSession;
    const tools = [
      ...b.bridge.tools.map((def) =>
        gateToolDefinition(
          def,
          this.config.policy,
          (req) => this.session.requestApproval({ ...req, chatId }),
          () => ({ followUp: (t: string) => piSession.followUp(t) }),
          () => ({ sessionId: this.session.id, chatId }),
        ),
      ),
      gateToolDefinition(
        buildClipboardTool(),
        this.config.policy,
        (req) => this.session.requestApproval({ ...req, chatId }),
        () => ({ followUp: (t: string) => piSession.followUp(t) }),
        () => ({ sessionId: this.session.id, chatId }),
      ),
      buildAskUserTool((q) => this.session.askQuestion(q, chatId)),
    ];
    const { session: created } = await createAgentSession({
      model: b.model, modelRegistry: b.modelRegistry, resourceLoader: b.resourceLoader,
      sessionManager, noTools: "builtin", customTools: tools,
    });
    piSession = created;

    const runtime: ChatRuntime = {
      chatId, session: piSession, unsub: () => {},
      lastCostUsd: 0, lastTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      assistantBuffer: "", aborted: false, starts: new Map(), toolInputs: new Map(),
    };
    runtime.unsub = piSession.subscribe((e: any) => this.onPiEvent(runtime, e));
    this.chats.set(chatId, runtime);
    return runtime;
  }

  /** Map a Pi session event to channel events + transcript persistence. */
  private onPiEvent(runtime: ChatRuntime, e: any): void {
    const store = chatStore();
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      const delta = e.assistantMessageEvent.delta;
      if (delta) {
        runtime.assistantBuffer += delta;
        this.emit({ type: "assistant_token", sessionId: this.session.id, chatId: runtime.chatId, text: delta });
      }
      return;
    }
    if (e.type === "tool_execution_start") {
      // Flush any assistant text emitted before this tool call so it lands in the
      // transcript in its actual chronological position, interleaved between tool
      // messages — instead of only being flushed once at the end of the whole turn.
      const pendingText = runtime.assistantBuffer.trim();
      if (pendingText) {
        store.addMessage(runtime.chatId, { id: randomUUID(), role: "assistant", text: pendingText });
        recordAudit({
          actor: "assistant",
          eventType: "chat.assistant_message",
          risk: "low",
          summary: pendingText.slice(0, 180),
          sessionId: this.session.id,
          chatId: runtime.chatId,
          payload: { text: pendingText },
        });
      }
      runtime.assistantBuffer = "";
      if (e.toolCallId) { runtime.starts.set(e.toolCallId, Date.now()); runtime.toolInputs.set(e.toolCallId, e.args ?? {}); }
      recordAudit({
        actor: "assistant",
        eventType: "tool.requested",
        risk: "medium",
        summary: `Assistant requested ${e.toolName}`,
        sessionId: this.session.id,
        chatId: runtime.chatId,
        toolName: e.toolName,
        toolCallId: e.toolCallId ?? "",
        payload: { input: e.args ?? {} },
      });
      this.emit({ type: "tool_call", sessionId: this.session.id, chatId: runtime.chatId, toolCallId: e.toolCallId ?? "", tool: e.toolName, input: e.args ?? {} });
      return;
    }
    if (e.type === "tool_execution_end") {
      const startedAt = e.toolCallId ? runtime.starts.get(e.toolCallId) : undefined;
      const input = e.toolCallId ? runtime.toolInputs.get(e.toolCallId) : undefined;
      if (e.toolCallId) { runtime.starts.delete(e.toolCallId); runtime.toolInputs.delete(e.toolCallId); }
      const durationMs = startedAt != null ? Date.now() - startedAt : 0;
      const ok = !e.isError;
      const output = extractToolOutput(e.result);
      const files = filesFromOutput(output);
      const error = ok ? undefined : (typeof output === "string" ? output : JSON.stringify(output));
      try { usageLedger().recordTool({ ts: Date.now(), sessionId: runtime.chatId, tool: e.toolName, durationMs, ok }); } catch { /* ledger optional */ }
      recordAudit({
        actor: "tool",
        eventType: ok ? "tool.completed" : "tool.failed",
        risk: ok ? "low" : "medium",
        summary: `Tool ${e.toolName} ${ok ? "completed" : "failed"}`,
        sessionId: this.session.id,
        chatId: runtime.chatId,
        toolName: e.toolName,
        toolCallId: e.toolCallId ?? "",
        ok,
        durationMs,
        payload: { input, output, error },
        sourceRefs: files.map((file) => ({ type: "file", path: file.path, id: file.token, label: file.name })),
      });
      try {
        store.addMessage(runtime.chatId, toolMessage({
          tool: e.toolName, input, toolCallId: e.toolCallId ?? "", ok, output, durationMs, error, files,
        }));
      } catch { /* transcript optional */ }
      this.emit({
        type: "tool_result", sessionId: this.session.id, chatId: runtime.chatId, toolCallId: e.toolCallId ?? "", tool: e.toolName,
        ok, output, durationMs, ...(files.length ? { files } : {}), ...(error ? { error } : {}),
      });
    }
  }

  /** Run one user turn against a chat, persisting the transcript + usage. */
  async runTurn(chatId: string, prompt: string, attachments?: ChannelFile[]): Promise<void> {
    return this.turnQueue.run(chatId, () => this.doRunTurn(chatId, prompt, attachments));
  }

  private async doRunTurn(chatId: string, prompt: string, attachments?: ChannelFile[]): Promise<void> {
    const store = chatStore();
    // A turn queued behind another can run after its chat was deleted; do not
    // resurrect a deleted chat (addMessage orphan row + ensureChat rebuilding a session).
    if (!store.exists(chatId)) return;
    const attached = (attachments ?? []).filter((a) => a.path);
    store.addMessage(chatId, { id: randomUUID(), role: "user", text: prompt, ...(attached.length ? { attachments: attached } : {}) });
    store.maybeAutoTitle(chatId, prompt);
    recordAudit({
      actor: "user",
      eventType: "chat.user_message",
      risk: "low",
      summary: prompt.trim().slice(0, 180) || "User sent attachments",
      sessionId: this.session.id,
      chatId,
      payload: { text: prompt, attachments: attached },
      sourceRefs: attached.map((file) => ({ type: "file", path: file.path, id: file.token, label: file.name })),
    });

    const runtime = await this.ensureChat(chatId);
    if (this.session.closed) return;
    runtime.assistantBuffer = "";
    runtime.aborted = false;

    // Surface user-attached files to the agent as absolute paths it can pass to
    // send_email/reply (which attach by path).
    const piPrompt = attached.length
      ? `${prompt}\n\n[Files the user attached — absolute paths on disk. If the user wants them sent by email, pass these in the send_email/reply "attachments" array:]\n${attached.map((a) => `- ${a.name}: ${a.path}`).join("\n")}`
      : prompt;

    markRunning(chatId);
    this.emit({ type: "status", sessionId: this.session.id, chatId, state: "running" });
    try {
      await runtime.session.prompt(piPrompt);
      const text = runtime.assistantBuffer.trim();
      if (text) {
        store.addMessage(chatId, { id: randomUUID(), role: "assistant", text });
        recordAudit({
          actor: "assistant",
          eventType: "chat.assistant_message",
          risk: "low",
          summary: text.slice(0, 180),
          sessionId: this.session.id,
          chatId,
          payload: { text },
        });
      }
      this.emit({ type: "assistant_done", sessionId: this.session.id, chatId });
    } catch (err) {
      // A user-requested stop surfaces as an abort here — not a real error.
      if (runtime.aborted) {
        const text = runtime.assistantBuffer.trim();
        if (text) {
          store.addMessage(chatId, { id: randomUUID(), role: "assistant", text });
          recordAudit({
            actor: "assistant",
            eventType: "chat.assistant_message",
            risk: "low",
            summary: text.slice(0, 180),
            sessionId: this.session.id,
            chatId,
            payload: { text, aborted: true },
          });
        }
        recordAudit({
          actor: "user",
          eventType: "chat.stop",
          risk: "low",
          summary: "User stopped generation",
          sessionId: this.session.id,
          chatId,
          ok: true,
        });
        this.emit({ type: "assistant_done", sessionId: this.session.id, chatId });
      } else {
        recordAudit({
          actor: "host",
          eventType: "chat.error",
          risk: "medium",
          summary: err instanceof Error ? err.message : String(err),
          sessionId: this.session.id,
          chatId,
          ok: false,
          payload: { error: err instanceof Error ? err.stack ?? err.message : String(err) },
        });
        this.emit({ type: "error", sessionId: this.session.id, chatId, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      try {
        const stats = runtime.session.getSessionStats();
        const turnCostUsd = Math.max(0, stats.cost - runtime.lastCostUsd);
        const prev = runtime.lastTokens;
        const turn = {
          input: Math.max(0, stats.tokens.input - prev.input),
          output: Math.max(0, stats.tokens.output - prev.output),
          cacheRead: Math.max(0, stats.tokens.cacheRead - prev.cacheRead),
          cacheWrite: Math.max(0, stats.tokens.cacheWrite - prev.cacheWrite),
        };
        runtime.lastCostUsd = stats.cost;
        runtime.lastTokens = { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite };
        this.emit({ type: "usage", sessionId: this.session.id, chatId, turnCostUsd, costUsd: stats.cost, tokens: stats.tokens });
      } catch { /* stats unavailable */ }
      markIdle(chatId);
      this.emit({ type: "status", sessionId: this.session.id, chatId, state: "idle" });
    }
  }

  /** Stop the in-flight turn of a chat (defaults to the active one). */
  async abort(chatId?: string): Promise<void> {
    const id = chatId ?? this.session.activeChatId ?? undefined;
    const runtime = id ? this.chats.get(id) : undefined;
    if (!runtime) return;
    runtime.aborted = true;
    recordAudit({
      actor: "user",
      eventType: "chat.stop_requested",
      risk: "low",
      summary: "Stop requested",
      sessionId: this.session.id,
      chatId: id,
    });
    try { await runtime.session.abort(); } catch { /* already idle */ }
  }

  /** Tear down a chat's live session (called when the chat is deleted). */
  dispose(chatId: string): void {
    const r = this.chats.get(chatId);
    if (!r) return;
    r.aborted = true;               // suppress the spurious error emit from the aborted turn
    r.unsub();
    try { r.session.abort(); } catch { /* idle */ }
    r.session.dispose();
    this.chats.delete(chatId);
  }

  async close(): Promise<void> {
    for (const r of this.chats.values()) { r.unsub(); r.session.dispose(); }
    this.chats.clear();
    // The MCP bridge is process-shared (sharedMcpBridge) — do NOT close it here;
    // other connections and the action executor rely on it staying up.
  }
}
