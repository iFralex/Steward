import { randomUUID } from "node:crypto";
import { recordAudit } from "@steward/audit-log";
import { usageLedger } from "@steward/usage-ledger";

type ToolCaller = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

/** Execute a planner-selected read with the same accounting guarantees as a
 * chat tool call, even though the Action scanner runs without ChatManager. */
export async function executeObservedReadTool(
  callTool: ToolCaller,
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const toolCallId = randomUUID();
  recordAudit({
    actor: "scheduler", eventType: "tool.requested", risk: "low",
    summary: `Action scanner requested ${tool}`, toolName: tool, toolCallId,
    correlationId: "action-center:scan", payload: { input },
  });
  const startedAt = Date.now();
  try {
    const result = await callTool(tool, input);
    observe(tool, toolCallId, input, Date.now() - startedAt, true);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    observe(tool, toolCallId, input, Date.now() - startedAt, false, message);
    throw error;
  }
}

function observe(tool: string, toolCallId: string, input: Record<string, unknown>, durationMs: number, ok: boolean, error?: string): void {
  try {
    usageLedger().recordTool({ ts: Date.now(), sessionId: "action-center:scan", tool, durationMs, ok });
  } catch { /* usage is best-effort */ }
  recordAudit({
    actor: "tool", eventType: ok ? "tool.completed" : "tool.failed", risk: ok ? "low" : "medium",
    summary: `Action scanner ${ok ? "completed" : "failed"} ${tool}`, toolName: tool, toolCallId,
    correlationId: "action-center:scan", ok, durationMs, payload: { input, error },
  });
}
