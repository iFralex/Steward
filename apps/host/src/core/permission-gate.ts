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
  /** Read-only display context; never forwarded to the tool executor. */
  preview?: Record<string, unknown>;
  /** Chat whose turn requested this approval (routes the card in the UI). */
  chatId?: string;
}

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** Optional user note; surfaced to the model on deny, or as a follow-up on allow. */
  note?: string;
  /** Optional corrected args (approve-with-edit); replaces the call's input. */
  editedInput?: Record<string, unknown>;
  /** Machine-readable origin of a negative decision. Absence means an explicit user decision. */
  failureKind?: "explicit-deny" | "unrecognized" | "timeout" | "channel-error";
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

export interface ToolExecutionGuard {
  beforeExecute(tool: string, input: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string }>;
  afterExecute?(tool: string, input: Record<string, unknown>, error?: string): Promise<void>;
}

export interface PreflightToolDefinition extends ToolDefinition {
  /** Pure validation/normalization performed before an approval is requested. */
  preflightInput?: (input: Record<string, unknown>) => Record<string, unknown>;
}

export function gateToolDefinition(
  def: ToolDefinition,
  policy: ToolPolicy,
  requestApproval: RequestApproval,
  getSession: () => FollowUpSink,
  getAuditContext?: () => ToolAuditContext,
  executionGuard?: ToolExecutionGuard,
): ToolDefinition {
  return {
    ...def,
    execute: async (id: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => {
      const decision = decideTool(policy, def.name);
      const audit = getAuditContext?.() ?? {};
      let prepared = toRecord(params);
      if (decision !== "deny") {
        const preflight = (def as PreflightToolDefinition).preflightInput;
        if (preflight) {
          try {
            prepared = preflight(prepared);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordAudit({
              actor: "host", eventType: "tool.preflight_failed", risk: "medium",
              summary: `Tool ${def.name} input is invalid`, sessionId: audit.sessionId,
              chatId: audit.chatId, toolName: def.name, toolCallId: id, ok: false,
              payload: { input: toRecord(params), error: message },
            });
            throw new Error(`Invalid ${def.name} request: ${message}`);
          }
        }
      }
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
        payload: { input: prepared, decision },
      });
      if (decision === "deny") {
        return blocked(`Tool ${def.name} is disabled by policy.`);
      }
      if (decision === "allow") {
        return executeGuarded(def, id, prepared, signal, onUpdate, ctx, executionGuard);
      }
      // gate → ask the user
      const outcome = await requestApproval({ tool: def.name, input: prepared });
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
          originalInput: prepared,
          editedInput: outcome.editedInput,
          failureKind: outcome.failureKind,
        },
      });
      if (outcome.decision === "revise") {
        const how = outcome.note?.trim() ? `: ${outcome.note.trim()}` : "";
        return blocked(`NOT DONE — user requested a revision${how}. Revise the tool input/action accordingly and try again only when the revised plan is ready.`);
      }
      if (outcome.decision !== "allow") {
        const why = outcome.note?.trim() ? `: ${outcome.note.trim()}` : "";
        if (outcome.failureKind && outcome.failureKind !== "explicit-deny") {
          return blocked(`NOT DONE — approval could not be obtained (${outcome.failureKind})${why}. Nothing was executed. Do not describe this as a user rejection.`);
        }
        return blocked(`NOT DONE — denied by user${why}. Do not retry; propose an alternative.`);
      }
      // Approve-with-edit: the approval card may return corrected arguments
      // (carried by approval_decision.editedInput); run the tool with those.
      let args = outcome.editedInput ?? prepared;
      if (outcome.editedInput) {
        const preflight = (def as PreflightToolDefinition).preflightInput;
        if (preflight) {
          try {
            args = preflight(outcome.editedInput);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid approved edit for ${def.name}: ${message}`);
          }
        }
      }
      if (outcome.note?.trim()) {
        await getSession().followUp(`User note: ${outcome.note.trim()}`);
      }
      return executeGuarded(def, id, args, signal, onUpdate, ctx, executionGuard);
    },
  };
}

async function executeGuarded(
  def: ToolDefinition,
  id: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
  guard?: ToolExecutionGuard,
) {
  const input = toRecord(params);
  if (guard) {
    const authorization = await guard.beforeExecute(def.name, input);
    if (!authorization.allowed) return blocked(authorization.reason ?? `Tool ${def.name} is outside the approved watch grant.`);
  }
  try {
    const output = await def.execute(id, params as never, signal as never, onUpdate as never, ctx as never);
    await guard?.afterExecute?.(def.name, input);
    return output;
  } catch (error) {
    await guard?.afterExecute?.(def.name, input, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function blocked(text: string) {
  return { content: [{ type: "text" as const, text }], details: { stewardOutcome: "blocked" } };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
