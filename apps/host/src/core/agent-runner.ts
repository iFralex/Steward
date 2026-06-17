/**
 * Agent runner — wraps the Claude Agent SDK `query()` for one turn,
 * wiring the permission gate (deterministic tool approval) and the MCP
 * servers, and translating the SDK message stream into channel events.
 *
 * We reuse the SDK's agent loop; we do not hand-roll it.
 */
import { query, type Options, type SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { createPermissionGate } from "./permission-gate.ts";
import type { Emit, Session } from "./session.ts";
import type { HostConfig } from "../config.ts";

/** Run a single user turn through the agent, emitting channel events. */
export async function runTurn(
  config: HostConfig,
  session: Session,
  emit: Emit,
  prompt: string,
): Promise<void> {
  const canUseTool = createPermissionGate(config.policy, session.requestApproval);

  emit({ type: "status", sessionId: session.id, state: "running" });
  try {
    const options: Options = {
      model: config.model,
      systemPrompt: config.systemPrompt,
      mcpServers: config.mcpServers,
      canUseTool,
      // Isolation: do NOT inherit the user's Claude Code settings/permissions
      // (otherwise tools they've allowed — e.g. Bash — bypass our gate).
      settingSources: [],
      permissionMode: "default",
      // Keep conversation memory across turns by resuming the prior session.
      ...(session.lastSessionId ? { resume: session.lastSessionId } : {}),
    };

    for await (const message of query({ prompt, options })) {
      if ("session_id" in message && typeof message.session_id === "string") {
        session.lastSessionId = message.session_id;
      }
      if (message.type === "assistant") {
        const text = extractAssistantText(message);
        if (text) emit({ type: "assistant_token", sessionId: session.id, text });
      }
    }
    emit({ type: "assistant_done", sessionId: session.id });
  } catch (err) {
    emit({
      type: "error",
      sessionId: session.id,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    emit({ type: "status", sessionId: session.id, state: "idle" });
  }
}

/** Concatenate the text blocks of an assistant message. */
function extractAssistantText(message: SDKAssistantMessage): string {
  let out = "";
  for (const block of message.message.content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}
