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
  ChannelFile,
  ChatSummary,
  ClientEvent,
  PersistedMessage,
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
  /** For role "tool": on-disk files the tool produced (openable/draggable). */
  toolFiles?: ChannelFile[];
  /** For role "user": files the user attached to this message. */
  attachments?: ChannelFile[];
  /** When the message was created (epoch ms). */
  ts?: number;
  /** True while the assistant is still streaming into this message. */
  open?: boolean;
}

export interface PendingApproval {
  requestId: string;
  tool: string;
  input: unknown;
}

export interface PendingQuestion {
  requestId: string;
  question: string;
  options: string[];
  multiSelect: boolean;
}

export interface SessionUsage {
  turnCostUsd: number;
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface HostSocket {
  connected: boolean;
  state: SessionState;
  messages: ChatMessage[];
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  usage: SessionUsage | null;
  actionCenter: ActionCenterState | null;
  chats: ChatSummary[];
  activeChatId: string | null;
  createChat: () => void;
  selectChat: (chatId: string) => void;
  renameChat: (chatId: string, title: string) => void;
  deleteChat: (chatId: string) => void;
  saveChat: (chatId: string) => void;
  openActionChat: (id: number) => void;
  uploadFile: (file: File) => Promise<ChannelFile>;
  sendMessage: (text: string, attachments?: ChannelFile[]) => void;
  stop: () => void;
  respondQuestion: (requestId: string, selected: string[]) => void;
  openFile: (token: string) => void;
  revealFile: (token: string) => void;
  resolveFile: (key: string) => ChannelFile | undefined;
  registerPath: (key: string) => Promise<ChannelFile | undefined>;
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
  const httpBase = url.replace(/^ws/, "http"); // host's HTTP origin (upload/resolve/file)
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string>("");
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<SessionState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [actionCenter, setActionCenter] = useState<ActionCenterState | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  /** Files seen in tool results, keyed by both absolute path and name — lets inline `card:file` resolve to an openable file. */
  const filesRef = useRef<Map<string, ChannelFile>>(new Map());

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
            { id: crypto.randomUUID(), role: "tool", text: msg.tool, toolInput: msg.input, toolCallId: msg.toolCallId, toolStatus: "running", ts: Date.now() },
          ]);
          break;
        case "tool_result":
          if (msg.files) {
            for (const f of msg.files) {
              if (f.path) filesRef.current.set(f.path, f);
              filesRef.current.set(f.name, f);
            }
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "tool" && m.toolCallId === msg.toolCallId
                ? { ...m, toolStatus: msg.ok ? "ok" : "error", toolOutput: msg.output, toolDurationMs: msg.durationMs, toolError: msg.error, toolFiles: msg.files }
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
        case "question_request":
          setQuestions((prev) => [
            ...prev,
            { requestId: msg.requestId, question: msg.question, options: msg.options, multiSelect: msg.multiSelect },
          ]);
          break;
        case "usage":
          setUsage({ turnCostUsd: msg.turnCostUsd, costUsd: msg.costUsd, tokens: msg.tokens });
          break;
        case "chat_list":
          setChats(msg.chats);
          setActiveChatId(msg.activeChatId);
          break;
        case "chat_history":
          setActiveChatId(msg.chatId);
          setMessages(msg.messages.map(persistedToChat));
          setApprovals([]);
          setQuestions([]);
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
    (text: string, attachments?: ChannelFile[]) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text: trimmed, ts: Date.now(), ...(attachments?.length ? { attachments } : {}) },
      ]);
      send({ type: "user_message", sessionId: sessionRef.current, text: trimmed, chatId: activeChatId ?? undefined, attachments });
    },
    [send, activeChatId],
  );

  const stop = useCallback(() => send({ type: "stop", chatId: activeChatId ?? undefined }), [send, activeChatId]);

  const uploadFile = useCallback(async (file: File): Promise<ChannelFile> => {
    const res = await fetch(`${httpBase}/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    return (await res.json()) as ChannelFile;
  }, [httpBase]);

  const createChat = useCallback(() => send({ type: "chat_create" }), [send]);
  const selectChat = useCallback((chatId: string) => send({ type: "chat_select", chatId }), [send]);
  const renameChat = useCallback((chatId: string, title: string) => {
    const trimmed = title.trim();
    if (trimmed) send({ type: "chat_rename", chatId, title: trimmed });
  }, [send]);
  const deleteChat = useCallback((chatId: string) => send({ type: "chat_delete", chatId }), [send]);

  const refreshActions = useCallback(
    (includeDone = false) => send({ type: "action_center_refresh", sessionId: sessionRef.current, includeDone, limit: 100 }),
    [send],
  );

  const markAction = useCallback(
    (id: number, status: ActionStatus) => send({ type: "action_center_mark", sessionId: sessionRef.current, id, status }),
    [send],
  );

  const openActionChat = useCallback((id: number) => send({ type: "action_open_in_chat", id }), [send]);
  const saveChat = useCallback((chatId: string) => send({ type: "chat_save", chatId }), [send]);

  const executeProposal = useCallback(
    (id: number, proposalId: string) => send({ type: "action_center_execute", sessionId: sessionRef.current, id, proposalId }),
    [send],
  );

  const reviseProposal = useCallback(
    (id: number, proposalId: string, instruction: string) => {
      const trimmed = instruction.trim();
      if (!trimmed) return;
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

  const respondQuestion = useCallback(
    (requestId: string, selected: string[]) => {
      setQuestions((prev) => prev.filter((q) => q.requestId !== requestId));
      send({ type: "question_response", sessionId: sessionRef.current, requestId, selected });
    },
    [send],
  );

  const openFile = useCallback((token: string) => send({ type: "open_file", token }), [send]);
  const revealFile = useCallback((token: string) => send({ type: "reveal_file", token }), [send]);
  const resolveFile = useCallback((key: string) => filesRef.current.get(key), []);
  const registerPath = useCallback(async (key: string): Promise<ChannelFile | undefined> => {
    const cached = filesRef.current.get(key);
    if (cached) return cached;
    try {
      const res = await fetch(`${httpBase}/resolve?path=${encodeURIComponent(key)}`);
      if (!res.ok) return undefined;
      const file = (await res.json()) as ChannelFile;
      if (file.path) filesRef.current.set(file.path, file);
      filesRef.current.set(file.name, file);
      return file;
    } catch {
      return undefined;
    }
  }, [httpBase]);

  return { connected, state, messages, approvals, questions, usage, actionCenter, chats, activeChatId, createChat, selectChat, renameChat, deleteChat, saveChat, openActionChat, uploadFile, sendMessage, stop, respondQuestion, openFile, revealFile, resolveFile, registerPath, refreshActions, markAction, executeProposal, reviseProposal, respondApproval };
}

/** Map a persisted transcript message back into a renderable chat message. */
function persistedToChat(m: PersistedMessage): ChatMessage {
  return { ...m, ts: m.createdAt, open: false };
}

function appendAssistant(prev: ChatMessage[], text: string): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === "assistant" && last.open) {
    return [...prev.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...prev, { id: crypto.randomUUID(), role: "assistant", text, ts: Date.now(), open: true }];
}

function closeAssistant(prev: ChatMessage[]): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === "assistant" && last.open) {
    return [...prev.slice(0, -1), { ...last, open: false }];
  }
  return prev;
}
