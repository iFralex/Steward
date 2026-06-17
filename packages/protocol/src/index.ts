/**
 * Event protocol between the agent host core and any channel client
 * (the web UI first; Telegram / Discord later — all clients of the same
 * contract). Architecture "B": the core owns the loop, gating and
 * sessions; channels only speak these events.
 *
 * Keep this package dependency-free: it is the shared contract imported
 * by both the host (Node) and the web client (browser).
 */

/** Messages a channel sends INTO the core. */
export type ClientEvent =
  | { type: "user_message"; sessionId: string; text: string }
  | {
      type: "approval_decision";
      sessionId: string;
      requestId: string;
      decision: ApprovalDecision;
      /** Optional note shown to the agent when denying (why / what to do instead). */
      note?: string;
    };

/** Messages the core sends OUT to a channel. */
export type ServerEvent =
  | { type: "assistant_token"; sessionId: string; text: string }
  | { type: "assistant_done"; sessionId: string }
  | {
      /**
       * The core is asking the user to approve a sensitive tool call.
       * The channel renders `input` (typed payload, e.g. an email draft)
       * and replies with an `approval_decision` carrying this `requestId`.
       */
      type: "approval_request";
      sessionId: string;
      requestId: string;
      tool: string;
      input: unknown;
    }
  | { type: "tool_result"; sessionId: string; tool: string; ok: boolean; summary?: string }
  | { type: "status"; sessionId: string; state: SessionState }
  | { type: "error"; sessionId?: string; message: string };

export type ApprovalDecision = "allow" | "deny";
export type SessionState = "idle" | "running";
