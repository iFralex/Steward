/**
 * React hook for the host WebSocket: speaks the shared `@llm-wiki/protocol`
 * event contract. Accumulates the chat transcript, tracks pending tool
 * approvals, and exposes `sendMessage` / `respondApproval`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalDecision,
  ClientEvent,
  ServerEvent,
  SessionState,
} from "@llm-wiki/protocol";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
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
  sendMessage: (text: string) => void;
  respondApproval: (requestId: string, decision: ApprovalDecision, note?: string) => void;
}

export function useHostSocket(url: string): HostSocket {
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string>("");
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<SessionState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

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
        case "approval_request":
          setApprovals((prev) => [
            ...prev,
            { requestId: msg.requestId, tool: msg.tool, input: msg.input },
          ]);
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

  const respondApproval = useCallback(
    (requestId: string, decision: ApprovalDecision, note?: string) => {
      setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
      send({ type: "approval_decision", sessionId: sessionRef.current, requestId, decision, note });
    },
    [send],
  );

  return { connected, state, messages, approvals, sendMessage, respondApproval };
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
