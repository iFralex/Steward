/**
 * Deterministic tool gate, enforced by wrapping a tool's execute. Runs
 * decideTool before any side effect: deny → blocked result (tool never runs);
 * gate → await the user's approval; allow → run. Independent of model output.
 * requestApproval is injected so the wrapper stays pure/testable.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalDecision } from "@steward/protocol";
import { recordAudit } from "@steward/audit-log";
import { decideTool, type ToolPolicy } from "./tool-policy.ts";

export interface ApprovalRequest {
  tool: string;
  input: Record<string, unknown>;
  /** Chat whose turn requested this approval (routes the card in the UI). */
  chatId?: string;
}

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** Optional user note; surfaced to the model on deny, or as a follow-up on allow. */
  note?: string;
  /** Optional corrected args (approve-with-edit); replaces the call's input. */
  editedInput?: Record<string, unknown>;
}

export type RequestApproval = (req: ApprovalRequest) => Promise<ApprovalOutcome>;

/** Minimal view of the live Pi session the gate needs (for allow-notes). */
export interface FollowUpSink {
  followUp(text: string): Promise<void>;
}

export interface ToolAuditContext {
  sessionId?: string;
  chatId?: string;
}

export function gateToolDefinition(
  def: ToolDefinition,
  policy: ToolPolicy,
  requestApproval: RequestApproval,
  getSession: () => FollowUpSink,
  getAuditContext?: () => ToolAuditContext,
): ToolDefinition {
  return {
    ...def,
    execute: async (id: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => {
      const decision = decideTool(policy, def.name);
      const audit = getAuditContext?.() ?? {};
      recordAudit({
        actor: "host",
        eventType: `tool.policy.${decision}`,
        risk: decision === "allow" ? "low" : "high",
        summary: `Tool ${def.name} policy decision: ${decision}`,
        sessionId: audit.sessionId,
        chatId: audit.chatId,
        toolName: def.name,
        toolCallId: id,
        ok: decision !== "deny",
        payload: { input: toRecord(params), decision },
      });
      if (decision === "deny") {
        return blocked(`Tool ${def.name} is disabled by policy.`);
      }
      if (decision === "allow") {
        return def.execute(id, params as never, signal as never, onUpdate as never, ctx as never);
      }
      // gate → ask the user
      const outcome = await requestApproval({ tool: def.name, input: toRecord(params) });
      recordAudit({
        actor: "user",
        eventType: `approval.${outcome.decision}`,
        risk: "high",
        summary: `Approval ${outcome.decision} for ${def.name}`,
        sessionId: audit.sessionId,
        chatId: audit.chatId,
        toolName: def.name,
        toolCallId: id,
        ok: outcome.decision === "allow",
        payload: {
          decision: outcome.decision,
          note: outcome.note,
          originalInput: toRecord(params),
          editedInput: outcome.editedInput,
        },
      });
      if (outcome.decision === "revise") {
        const how = outcome.note?.trim() ? `: ${outcome.note.trim()}` : "";
        return blocked(`NOT DONE — user requested a revision${how}. Revise the tool input/action accordingly and try again only when the revised plan is ready.`);
      }
      if (outcome.decision !== "allow") {
        const why = outcome.note?.trim() ? `: ${outcome.note.trim()}` : "";
        return blocked(`NOT DONE — denied by user${why}. Do not retry; propose an alternative.`);
      }
      // Approve-with-edit: the approval card may return corrected arguments
      // (carried by approval_decision.editedInput); run the tool with those.
      const args = outcome.editedInput ?? (params as Record<string, unknown>);
      if (outcome.note?.trim()) {
        await getSession().followUp(`User note: ${outcome.note.trim()}`);
      }
      return def.execute(id, args as never, signal as never, onUpdate as never, ctx as never);
    },
  };
}

function blocked(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
