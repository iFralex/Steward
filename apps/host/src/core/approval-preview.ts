import { recordAudit } from "@steward/audit-log";
import { usageLedger } from "@steward/usage-ledger";

type ToolCaller = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

export interface ApprovalPreviewContext {
  sessionId?: string;
  chatId?: string;
  actionId?: number;
}

/**
 * Build read-only context for approval cards. The returned object travels in
 * the protocol's `preview` field and is never forwarded to the write tool.
 */
export async function buildApprovalPreview(
  tool: string,
  input: Record<string, unknown>,
  callTool: ToolCaller,
  context?: ApprovalPreviewContext,
): Promise<Record<string, unknown> | undefined> {
  try {
    if (tool === "create_agent_watch") {
      return { source: input.source, resourceRef: input.resourceRef, instruction: input.instruction, expiresAt: input.expiresAt, rules: input.rules };
    }
    if (["mcp__calendar__update_event", "mcp__calendar__delete_event"].includes(tool) && string(input.uid)) {
      return asRecord(await callJson(callTool, "mcp__calendar__read_event", { uid: input.uid }, context));
    }
    if (tool === "mcp__mail__reply" && (string(input.id) || string(input.messageId))) {
      const message = asRecord(await callJson(callTool, "mcp__mail__read_message", {
        ...(string(input.id) ? { id: input.id } : {}),
        ...(string(input.messageId) ? { messageId: input.messageId } : {}),
      }, context));
      if (!message) return undefined;
      return {
        subject: message.subject,
        to: message.from ? [message.from] : undefined,
        mailUrl: message.mailUrl,
      };
    }
    if (tool === "mcp__mail__cancel_scheduled" && string(input.operationId)) {
      const scheduled = await callJson(callTool, "mcp__mail__list_scheduled", {}, context);
      const item = Array.isArray(scheduled)
        ? scheduled.find((entry) => asRecord(entry)?.operationId === input.operationId)
        : undefined;
      const record = asRecord(item);
      return record ? { ...record, body: record.bodySnippet } : undefined;
    }
    if (tool === "mcp__action-center__mark_action" && Number.isSafeInteger(Number(input.id))) {
      return asRecord(await callJson(callTool, "mcp__action-center__read_action", { id: Number(input.id) }, context));
    }
    if (["mcp__action-center__set_flow_enabled", "mcp__action-center__delete_flow"].includes(tool) && Number.isSafeInteger(Number(input.id))) {
      const flows = await callJson(callTool, "mcp__action-center__list_flows", { limit: 100 }, context);
      const flow = Array.isArray(flows) ? flows.find((entry) => Number(asRecord(entry)?.id) === Number(input.id)) : undefined;
      return asRecord(flow);
    }
  } catch {
    // Approval remains available if a best-effort preview lookup fails.
  }
  return undefined;
}

async function callJson(callTool: ToolCaller, tool: string, input: Record<string, unknown>, context?: ApprovalPreviewContext): Promise<unknown> {
  const startedAt = Date.now();
  try {
    const decoded = decodeToolJson(await callTool(tool, input));
    observePreviewLookup(tool, input, context, Date.now() - startedAt, true);
    return decoded;
  } catch (error) {
    observePreviewLookup(tool, input, context, Date.now() - startedAt, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function observePreviewLookup(
  tool: string,
  input: Record<string, unknown>,
  context: ApprovalPreviewContext | undefined,
  durationMs: number,
  ok: boolean,
  error?: string,
): void {
  if (!context) return;
  try {
    usageLedger().recordTool({
      ts: Date.now(), sessionId: context.chatId ?? context.sessionId ?? "approval-preview",
      tool: `approval-preview:${tool}`, durationMs, ok,
    });
  } catch { /* usage is best-effort */ }
  recordAudit({
    actor: "host", eventType: ok ? "approval.preview_lookup_completed" : "approval.preview_lookup_failed",
    risk: ok ? "low" : "medium", summary: `${ok ? "Loaded" : "Failed to load"} approval preview with ${tool}`,
    sessionId: context.sessionId, chatId: context.chatId, actionId: context.actionId,
    toolName: tool, ok, durationMs, payload: { input, error },
  });
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decodeToolJson(result: unknown): unknown {
  const content = Array.isArray(result)
    ? result
    : Array.isArray((result as { content?: unknown })?.content)
      ? ((result as { content: unknown[] }).content)
      : [];
  const text = content
    .map((item) => typeof (item as { text?: unknown })?.text === "string" ? (item as { text: string }).text : "")
    .join("")
    .trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
