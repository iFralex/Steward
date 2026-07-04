/**
 * A conversation session: one per channel connection. Owns the pending
 * approvals and the bridge between the permission gate (which awaits a
 * decision) and the channel (which delivers it).
 */
import { randomUUID } from "node:crypto";
import type { ServerEvent } from "@steward/protocol";
import type { ApprovalOutcome, ApprovalRequest, RequestApproval } from "./permission-gate.ts";

export type Emit = (event: ServerEvent) => void;

export class Session {
  readonly id = randomUUID();
  /** Set to true when the channel disconnects; prevents mid-build runtime leaks. */
  closed = false;
  /** The chat the connection is currently focused on (per-connection routing). */
  activeChatId: string | null = null;
  private readonly pending = new Map<string, (outcome: ApprovalOutcome) => void>();
  private readonly pendingQuestions = new Map<string, (selected: string[]) => void>();

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
        ...(req.chatId ? { chatId: req.chatId } : {}),
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

  /**
   * The `ask_user` tool calls this: emit a `question_request` to the channel
   * and resolve with the labels the user selected (via `question_response`),
   * or `[]` on timeout. Mirrors `requestApproval` but for a plain question.
   */
  readonly askQuestion = (
    q: { question: string; options: string[]; multiSelect: boolean },
    chatId?: string,
  ): Promise<string[]> => {
    const requestId = randomUUID();
    return new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingQuestions.delete(requestId)) resolve([]);
      }, this.approvalTimeoutMs);

      this.pendingQuestions.set(requestId, (selected) => {
        clearTimeout(timer);
        resolve(selected);
      });

      this.emit({
        type: "question_request",
        sessionId: this.id,
        ...(chatId ? { chatId } : {}),
        requestId,
        question: q.question,
        options: q.options,
        multiSelect: q.multiSelect,
      });
    });
  };

  /** Deliver a channel answer to a waiting question. Returns false if unknown. */
  resolveQuestion(requestId: string, selected: string[]): boolean {
    const resolver = this.pendingQuestions.get(requestId);
    if (!resolver) return false;
    this.pendingQuestions.delete(requestId);
    resolver(selected);
    return true;
  }
}
