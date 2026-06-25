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
      /**
       * Optional corrected tool arguments (approve-with-edit): when the user
       * approves but tweaks the payload, the tool runs with this instead of the
       * originally-requested input. Ignored on deny.
       */
      editedInput?: Record<string, unknown>;
    }
  | {
      /**
       * The user's answer to a `question_request`: the labels they selected.
       * Single-select → exactly one; multi-select → zero or more. An empty
       * array (or no reply → timeout) means "no choice".
       */
      type: "question_response";
      sessionId: string;
      requestId: string;
      selected: string[];
    };

/** Messages the core sends OUT to a channel. */
export type ServerEvent =
  | { type: "assistant_token"; sessionId: string; text: string }
  | { type: "assistant_done"; sessionId: string }
  | {
      /** The agent invoked a tool (shown in the transcript so nothing is lost). */
      type: "tool_call";
      sessionId: string;
      tool: string;
      input: unknown;
    }
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
  | {
      /**
       * The agent is asking the user to pick among predefined options (the
       * `ask_user` tool). The channel renders `options` as a single- or
       * multi-select and replies with a `question_response` carrying this
       * `requestId`. This is a plain question, not a tool approval.
       */
      type: "question_request";
      sessionId: string;
      requestId: string;
      question: string;
      options: string[];
      multiSelect: boolean;
    }
  | { type: "tool_result"; sessionId: string; tool: string; ok: boolean; summary?: string }
  | { type: "status"; sessionId: string; state: SessionState }
  | { type: "error"; sessionId?: string; message: string };

export type ApprovalDecision = "allow" | "deny";
export type SessionState = "idle" | "running";
