/**
 * A conversation session: one per channel connection. Owns the pending
 * approvals and the bridge between the permission gate (which awaits a
 * decision) and the channel (which delivers it).
 */
import { randomUUID } from "node:crypto";
import type { ServerEvent } from "@llm-wiki/protocol";
import type { ApprovalOutcome, ApprovalRequest, RequestApproval } from "./permission-gate.ts";

export type Emit = (event: ServerEvent) => void;

export class Session {
  readonly id = randomUUID();
  private readonly pending = new Map<string, (outcome: ApprovalOutcome) => void>();

  constructor(
    private readonly emit: Emit,
    private readonly approvalTimeoutMs: number,
  ) {}

  /**
   * The `RequestApproval` the permission gate calls for a gated tool:
   * emit an `approval_request` to the channel and resolve when the
   * channel returns the user's `approval_decision` (or on timeout → deny).
   */
  readonly requestApproval: RequestApproval = (req: ApprovalRequest) => {
    const requestId = randomUUID();
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          resolve({ decision: "deny", note: "Approval timed out" });
        }
      }, this.approvalTimeoutMs);

      this.pending.set(requestId, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });

      this.emit({
        type: "approval_request",
        sessionId: this.id,
        requestId,
        tool: req.tool,
        input: req.input,
      });
    });
  };

  /** Deliver a channel decision to a waiting approval. Returns false if unknown. */
  resolveApproval(requestId: string, outcome: ApprovalOutcome): boolean {
    const resolver = this.pending.get(requestId);
    if (!resolver) return false;
    this.pending.delete(requestId);
    resolver(outcome);
    return true;
  }
}
