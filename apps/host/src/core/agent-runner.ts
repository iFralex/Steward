/**
 * Pi-based agent runner. One live AgentSession per host Session, reused across
 * turns (memory is inherent). Tools = the MCP servers bridged in and
 * gate-wrapped; model = the gateway tier. Pi events map to channel events.
 */
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { buildMcpBridge, type McpBridge } from "./mcp-bridge.ts";
import { gateToolDefinition } from "./permission-gate.ts";
import { registerGatewayModel } from "./pi-provider.ts";
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
  const tools = bridge.tools.map((def) =>
    gateToolDefinition(def, config.policy, hostSession.requestApproval, () => piSession),
  );

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

/** Run one user turn through the agent, emitting channel events. */
export async function runTurn(config: HostConfig, session: Session, emit: Emit, prompt: string): Promise<void> {
  if (!session.pi) {
    const runtime = await buildPiRuntime(config, session);
    if (session.closed) { await runtime.close(); return; }
    const unsub = runtime.session.subscribe((e: any) => {
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        if (e.assistantMessageEvent.delta) emit({ type: "assistant_token", sessionId: session.id, text: e.assistantMessageEvent.delta });
      } else if (e.type === "tool_execution_start") {
        emit({ type: "tool_call", sessionId: session.id, tool: e.toolName, input: e.args ?? {} });
      }
    });
    session.pi = {
      prompt: (t) => runtime.session.prompt(t),
      followUp: (t) => runtime.session.followUp(t),
      subscribe: runtime.session.subscribe.bind(runtime.session),
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
    emit({ type: "status", sessionId: session.id, state: "idle" });
  }
}
