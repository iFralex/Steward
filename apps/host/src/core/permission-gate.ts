/**
 * Permission gate — the deterministic enforcement point, implemented as a
 * Claude Agent SDK **PreToolUse hook**. The hook fires before EVERY tool
 * execution (unlike `canUseTool`, which the SDK's `default` permission
 * mode only consults for operations it itself deems "dangerous" — so a
 * "safe" Bash command would otherwise run un-gated). The hook returns a
 * `permissionDecision` of `allow` / `deny`, which the SDK honours,
 * independent of the model's output or the SDK's own heuristics.
 *
 * The user interaction is injected as `requestApproval` so the gate stays
 * pure and testable.
 */
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalDecision } from "@llm-wiki/protocol";
import { decideTool, type ToolPolicy } from "./tool-policy.ts";

export interface ApprovalRequest {
  tool: string;
  input: Record<string, unknown>;
}

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** Optional note from the user; surfaced to the agent either way. */
  note?: string;
}

export type RequestApproval = (req: ApprovalRequest) => Promise<ApprovalOutcome>;

/**
 * Build the PreToolUse hook. `allow` tools proceed immediately; `gate`
 * tools block on `requestApproval` and only proceed on an explicit user
 * allow. The user's note reaches the agent as additional context (allow)
 * or as the denial reason (deny).
 */
export function createPreToolUseGate(
  policy: ToolPolicy,
  requestApproval: RequestApproval,
): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};

    const toolName = input.tool_name;
    if (decideTool(policy, toolName) === "allow") {
      return allow();
    }

    const outcome = await requestApproval({ tool: toolName, input: toRecord(input.tool_input) });
    if (outcome.decision === "allow") {
      return allow(outcome.note);
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: outcome.note?.trim() || `Denied by user: ${toolName}`,
      },
    };
  };
}

function allow(note?: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      ...(note?.trim() ? { additionalContext: `User note: ${note.trim()}` } : {}),
    },
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
