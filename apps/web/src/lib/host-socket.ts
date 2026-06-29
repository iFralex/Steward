/**
 * React hook for the host WebSocket: speaks the shared `@llm-wiki/protocol`
 * event contract. Accumulates the chat transcript, tracks pending tool
 * approvals, and exposes `sendMessage` / `respondApproval`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionCenterState,
  ActionStatus,
  ApprovalDecision,
  ClientEvent,
  ServerEvent,
  SessionState,
} from "@llm-wiki/protocol";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  /** For role "tool": the tool's input payload. */
  toolInput?: unknown;
  /** For role "tool": correlates the call with its result. */
  toolCallId?: string;
  /** For role "tool": lifecycle of the invocation. */
  toolStatus?: "running" | "ok" | "error";
  /** For role "tool": the tool's result (set when it finishes). */
  toolOutput?: unknown;
  /** For role "tool": wall-clock duration in ms (set when it finishes). */
  toolDurationMs?: number;
  /** For role "tool": error message when it failed. */
  toolError?: string;
  /** True while the assistant is still streaming into this message. */
  open?: boolean;
}

export interface PendingApproval {
  requestId: string;
  tool: string;
  input: unknown;
}

export interface HostSocket {
  connected: boolean;
  state: SessionState;
  messages: ChatMessage[];
  approvals: PendingApproval[];
  actionCenter: ActionCenterState | null;
  sendMessage: (text: string) => void;
  refreshActions: (includeDone?: boolean) => void;
  markAction: (id: number, status: ActionStatus) => void;
  executeProposal: (id: number, proposalId: string) => void;
  reviseProposal: (id: number, proposalId: string, instruction: string) => void;
  respondApproval: (
    requestId: string,
    decision: ApprovalDecision,
    note?: string,
    editedInput?: Record<string, unknown>,
  ) => void;
}

export function useHostSocket(url: string): HostSocket {
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string>("");
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<SessionState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [actionCenter, setActionCenter] = useState<ActionCenterState | null>(null);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: ServerEvent;
      try {
        msg = JSON.parse(ev.data) as ServerEvent;
      } catch {
        return;
      }
      switch (msg.type) {
        case "status":
          sessionRef.current = msg.sessionId;
          setState(msg.state);
          break;
        case "assistant_token":
          setMessages((prev) => appendAssistant(prev, msg.text));
          break;
        case "assistant_done":
          setMessages((prev) => closeAssistant(prev));
          break;
        case "tool_call":
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "tool", text: msg.tool, toolInput: msg.input, toolCallId: msg.toolCallId, toolStatus: "running" },
          ]);
          break;
        case "tool_result":
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "tool" && m.toolCallId === msg.toolCallId
                ? { ...m, toolStatus: msg.ok ? "ok" : "error", toolOutput: msg.output, toolDurationMs: msg.durationMs, toolError: msg.error }
                : m,
            ),
          );
          break;
        case "approval_request":
          setApprovals((prev) => [
            ...prev,
            { requestId: msg.requestId, tool: msg.tool, input: msg.input },
          ]);
          break;
        case "action_center_state":
          setActionCenter(msg.state);
          break;
        case "error":
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "assistant", text: `⚠️ ${msg.message}` },
          ]);
          break;
      }
    };
    return () => ws.close();
  }, [url]);

  const send = useCallback((event: ClientEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text: trimmed },
      ]);
      send({ type: "user_message", sessionId: sessionRef.current, text: trimmed });
    },
    [send],
  );

  const refreshActions = useCallback(
    (includeDone = false) => send({ type: "action_center_refresh", sessionId: sessionRef.current, includeDone, limit: 100 }),
    [send],
  );

  const markAction = useCallback(
    (id: number, status: ActionStatus) => send({ type: "action_center_mark", sessionId: sessionRef.current, id, status }),
    [send],
  );

  const executeProposal = useCallback(
    (id: number, proposalId: string) => send({ type: "action_center_execute", sessionId: sessionRef.current, id, proposalId }),
    [send],
  );

  const reviseProposal = useCallback(
    (id: number, proposalId: string, instruction: string) => {
      const trimmed = instruction.trim();
      if (!trimmed) return;
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text: `Revise proposal ${proposalId}: ${trimmed}` },
      ]);
      send({ type: "action_center_revise", sessionId: sessionRef.current, id, proposalId, instruction: trimmed });
    },
    [send],
  );

  const respondApproval = useCallback(
    (
      requestId: string,
      decision: ApprovalDecision,
      note?: string,
      editedInput?: Record<string, unknown>,
    ) => {
      setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
      send({
        type: "approval_decision",
        sessionId: sessionRef.current,
        requestId,
        decision,
        note,
        editedInput,
      });
    },
    [send],
  );

  return { connected, state, messages, approvals, actionCenter, sendMessage, refreshActions, markAction, executeProposal, reviseProposal, respondApproval };
}

function appendAssistant(prev: ChatMessage[], text: string): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === "assistant" && last.open) {
    return [...prev.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...prev, { id: crypto.randomUUID(), role: "assistant", text, open: true }];
}

function closeAssistant(prev: ChatMessage[]): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === "assistant" && last.open) {
    return [...prev.slice(0, -1), { ...last, open: false }];
  }
  return prev;
}
