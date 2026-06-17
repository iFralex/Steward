/**
 * Permission gate — bridges the Claude Agent SDK's `canUseTool`
 * permission callback to our approval protocol, deciding via the
 * {@link ToolPolicy} whether a tool call runs automatically or must be
 * confirmed by the user.
 *
 * This is the deterministic enforcement point: the model can only
 * *request* a tool; the SDK calls this gate before *executing* it, and
 * the gate — not the model — decides. A gated (sensitive) call blocks
 * until the user approves, so a hallucinated `send_email`/`Bash` cannot
 * fire on its own.
 *
 * The actual user interaction is injected as `requestApproval` so the
 * gate stays pure and testable (the session/WS layer provides the real
 * one that emits an `approval_request` event and awaits the decision).
 */
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalDecision } from "@llm-wiki/protocol";
import { decideTool, type ToolPolicy } from "./tool-policy.ts";

export interface ApprovalRequest {
  tool: string;
  input: Record<string, unknown>;
}

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** Optional note from the user, surfaced to the agent on a deny. */
  note?: string;
}

export type RequestApproval = (req: ApprovalRequest) => Promise<ApprovalOutcome>;

/**
 * Build a `CanUseTool` callback for the Agent SDK from a policy and an
 * approval requester. `allow` tools run immediately; `gate` tools block
 * on `requestApproval` and only run on an explicit user `allow`.
 */
export function createPermissionGate(
  policy: ToolPolicy,
  requestApproval: RequestApproval,
): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (decideTool(policy, toolName) === "allow") {
      return { behavior: "allow", updatedInput: input };
    }
    const outcome = await requestApproval({ tool: toolName, input });
    if (outcome.decision === "allow") {
      return { behavior: "allow", updatedInput: input };
    }
    return {
      behavior: "deny",
      message: outcome.note?.trim() || `Denied by user: ${toolName}`,
    };
  };
}
