/**
 * Pi-based agent runner. One live AgentSession per host Session, reused across
 * turns (memory is inherent). Tools = the MCP servers bridged in and
 * gate-wrapped; model = the gateway tier. Pi events map to channel events.
 */
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { buildMcpBridge, type McpBridge } from "@llm-wiki/mcp-bridge";
import { gateToolDefinition } from "./permission-gate.ts";
import { buildAskUserTool } from "./ask-user-tool.ts";
import { filesFromOutput } from "./file-registry.ts";
import { registerGatewayModel } from "./pi-provider.ts";
import { usageStore } from "./usage-store.ts";
import type { Emit, Session } from "./session.ts";
import type { HostConfig } from "../config.ts";

export interface PiRuntime {
  session: AgentSession;
  bridge: McpBridge;
  close(): Promise<void>;
}

/** Build the Pi runtime (provider + bridge + gate-wrapped tools + session). */
export async function buildPiRuntime(config: HostConfig, hostSession: Session): Promise<PiRuntime> {
  const { modelRegistry, model } = registerGatewayModel(config.gateway);
  const bridge = await buildMcpBridge(config.mcpServers);

  let piSession: AgentSession;
  const tools = [
    ...bridge.tools.map((def) =>
      gateToolDefinition(def, config.policy, hostSession.requestApproval, () => piSession),
    ),
    // Host-native question tool — not bridged, not gated.
    buildAskUserTool(hostSession.askQuestion),
  ];

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    systemPromptOverride: () => config.systemPrompt,
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true,
  });
  await resourceLoader.reload();

  let created;
  try {
    created = await createAgentSession({
      model, modelRegistry, resourceLoader,
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
      customTools: tools,
    });
  } catch (err) {
    await bridge.close();
    throw err;
  }
  piSession = created.session;

  return {
    session: piSession,
    bridge,
    close: async () => { piSession.dispose(); await bridge.close(); },
  };
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

/** Run one user turn through the agent, emitting channel events. */
export async function runTurn(config: HostConfig, session: Session, emit: Emit, prompt: string): Promise<void> {
  if (!session.pi) {
    const runtime = await buildPiRuntime(config, session);
    if (session.closed) { await runtime.close(); return; }
    const toolStarts = new Map<string, number>();
    const unsub = runtime.session.subscribe((e: any) => {
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        if (e.assistantMessageEvent.delta) emit({ type: "assistant_token", sessionId: session.id, text: e.assistantMessageEvent.delta });
      } else if (e.type === "tool_execution_start") {
        if (e.toolCallId) toolStarts.set(e.toolCallId, Date.now());
        emit({ type: "tool_call", sessionId: session.id, toolCallId: e.toolCallId ?? "", tool: e.toolName, input: e.args ?? {} });
      } else if (e.type === "tool_execution_end") {
        const startedAt = e.toolCallId ? toolStarts.get(e.toolCallId) : undefined;
        if (e.toolCallId) toolStarts.delete(e.toolCallId);
        const durationMs = startedAt != null ? Date.now() - startedAt : 0;
        const ok = !e.isError;
        const output = extractToolOutput(e.result);
        const files = filesFromOutput(output);
        try {
          usageStore().recordTool({ ts: Date.now(), sessionId: session.id, tool: e.toolName, durationMs, ok });
        } catch { /* usage ledger unavailable — don't break the turn */ }
        emit({
          type: "tool_result",
          sessionId: session.id,
          toolCallId: e.toolCallId ?? "",
          tool: e.toolName,
          ok,
          output,
          durationMs,
          ...(files.length ? { files } : {}),
          ...(ok ? {} : { error: typeof output === "string" ? output : JSON.stringify(output) }),
        });
      }
    });
    session.pi = {
      prompt: (t) => runtime.session.prompt(t),
      followUp: (t) => runtime.session.followUp(t),
      subscribe: runtime.session.subscribe.bind(runtime.session),
      getStats: () => runtime.session.getSessionStats(),
      close: async () => { unsub(); await runtime.close(); },
    };
  }

  emit({ type: "status", sessionId: session.id, state: "running" });
  try {
    await session.pi.prompt(prompt);
    emit({ type: "assistant_done", sessionId: session.id });
  } catch (err) {
    emit({ type: "error", sessionId: session.id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    try {
      const stats = session.pi?.getStats();
      if (stats) {
        const turnCostUsd = Math.max(0, stats.cost - session.lastCostUsd);
        const prev = session.lastTokens;
        const turn = {
          input: Math.max(0, stats.tokens.input - prev.input),
          output: Math.max(0, stats.tokens.output - prev.output),
          cacheRead: Math.max(0, stats.tokens.cacheRead - prev.cacheRead),
          cacheWrite: Math.max(0, stats.tokens.cacheWrite - prev.cacheWrite),
        };
        session.lastCostUsd = stats.cost;
        session.lastTokens = { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite };
        try {
          usageStore().record({
            ts: Date.now(),
            sessionId: session.id,
            model: config.gateway.tier,
            inputTokens: turn.input,
            outputTokens: turn.output,
            cacheReadTokens: turn.cacheRead,
            cacheWriteTokens: turn.cacheWrite,
            costUsd: turnCostUsd,
          });
        } catch { /* usage ledger unavailable — don't break the turn */ }
        emit({ type: "usage", sessionId: session.id, turnCostUsd, costUsd: stats.cost, tokens: stats.tokens });
      }
    } catch { /* stats unavailable */ }
    emit({ type: "status", sessionId: session.id, state: "idle" });
  }
}
