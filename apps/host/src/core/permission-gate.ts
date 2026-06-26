/**
 * Deterministic tool gate, enforced by wrapping a tool's execute. Runs
 * decideTool before any side effect: deny → blocked result (tool never runs);
 * gate → await the user's approval; allow → run. Independent of model output.
 * requestApproval is injected so the wrapper stays pure/testable.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalDecision } from "@llm-wiki/protocol";
import { decideTool, type ToolPolicy } from "./tool-policy.ts";

export interface ApprovalRequest {
  tool: string;
  input: Record<string, unknown>;
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

export function gateToolDefinition(
  def: ToolDefinition,
  policy: ToolPolicy,
  requestApproval: RequestApproval,
  getSession: () => FollowUpSink,
): ToolDefinition {
  return {
    ...def,
    execute: async (id: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => {
      const decision = decideTool(policy, def.name);
      if (decision === "deny") {
        return blocked(`Tool ${def.name} is disabled. Use Apple Mail (mail tools) for email.`);
      }
      if (decision === "allow") {
        return def.execute(id, params as never, signal as never, onUpdate as never, ctx as never);
      }
      // gate → ask the user
      const outcome = await requestApproval({ tool: def.name, input: toRecord(params) });
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
