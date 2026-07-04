/**
 * React hook for the host WebSocket: speaks the shared `@steward/protocol`
 * event contract. Accumulates the chat transcript, tracks pending tool
 * approvals, and exposes `sendMessage` / `respondApproval`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth";
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
} from "@steward/protocol";

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
  /** Chat this approval belongs to (routes the card; survives chat switches). */
  chatId?: string;
}

export interface PendingQuestion {
  requestId: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  /** Chat this question belongs to (routes the card; survives chat switches). */
  chatId?: string;
}

/** Sentinel key for a "running" signal with no chatId (legacy/global status). */
const GLOBAL_STATUS_KEY = "__global__";

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

export function useHostSocket(url: string, token: string | null, onUnauthorized: () => void): HostSocket {
  const httpBase = url.replace(/^ws/, "http"); // host's HTTP origin (upload/resolve/file)
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string>("");
  const [connected, setConnected] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [actionCenter, setActionCenter] = useState<ActionCenterState | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  /** Files seen in tool results, keyed by both absolute path and name — lets inline `card:file` resolve to an openable file. */
  const filesRef = useRef<Map<string, ChannelFile>>(new Map());

  /** Per-chat transcript, keyed by chatId; `messages` mirrors the active chat's list. */
  const messagesByChat = useRef<Map<string, ChatMessage[]>>(new Map());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const activeChatRef = useRef<string | null>(null);
  useEffect(() => {
    activeChatRef.current = activeChatId;
  }, [activeChatId]);

  /** Apply fn to a chat's list; re-render only if it's the visible one. */
  const updateChat = (chatId: string | null, fn: (prev: ChatMessage[]) => ChatMessage[]) => {
    const key = chatId ?? activeChatRef.current ?? "";
    const next = fn(messagesByChat.current.get(key) ?? []);
    messagesByChat.current.set(key, next);
    if (key === (activeChatRef.current ?? "")) setMessages(next);
  };

  /** Chats currently running a turn (per-chat status) + whether the "global" (no-chatId) signal is on. */
  const runningChatsRef = useRef<Set<string>>(new Set());
  const [statusVersion, setStatusVersion] = useState(0);
  const state: SessionState = runningChatsRef.current.has(activeChatId ?? "") || runningChatsRef.current.has(GLOBAL_STATUS_KEY)
    ? "running"
    : "idle";
  // statusVersion is read only to force a re-render when the ref above changes.
  void statusVersion;

  useEffect(() => {
    let disposed = false;
    let retryMs = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed) return;
      const wsUrl = token ? `${url}/?token=${encodeURIComponent(token)}` : url;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        retryMs = 500;
        setConnected(true);
        // A reconnect means the server tore down any in-flight turn; clear stale
        // "running" flags and half-streamed bubbles so they don't hang forever.
        runningChatsRef.current.clear();
        for (const [k, msgs] of messagesByChat.current) {
          messagesByChat.current.set(
            k,
            msgs.filter((m) => m.toolStatus !== "running").map((m) => (m.open ? { ...m, open: false } : m)),
          );
        }
        setStatusVersion((v) => v + 1);
        if (activeChatRef.current) setMessages(messagesByChat.current.get(activeChatRef.current) ?? []);
      };
      ws.onclose = () => {
        // Ignore a close from a socket that's been disposed or already replaced
        // by a newer one — otherwise a stale close can flip `connected` back to
        // false right after a reconnect opened (Send button stuck "disabled").
        if (disposed || wsRef.current !== ws) return;
        setConnected(false);
        timer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 5000); // 0.5s → 5s cap
      };
      ws.onmessage = (ev: MessageEvent<string>) => {
        let msg: ServerEvent;
        try {
          msg = JSON.parse(ev.data) as ServerEvent;
        } catch {
          return;
        }
        switch (msg.type) {
          case "status": {
            sessionRef.current = msg.sessionId;
            if (msg.chatId) {
              if (msg.state === "running") runningChatsRef.current.add(msg.chatId);
              else runningChatsRef.current.delete(msg.chatId);
            } else if (msg.state === "running") {
              runningChatsRef.current.add(GLOBAL_STATUS_KEY);
            } else {
              runningChatsRef.current.delete(GLOBAL_STATUS_KEY);
            }
            setStatusVersion((v) => v + 1);
            break;
          }
          case "assistant_token":
            updateChat(msg.chatId ?? null, (prev) => appendAssistant(prev, msg.text));
            break;
          case "assistant_done":
            updateChat(msg.chatId ?? null, (prev) => closeAssistant(prev));
            break;
          case "tool_call":
            updateChat(msg.chatId ?? null, (prev) => [
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
            updateChat(msg.chatId ?? null, (prev) =>
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
              { requestId: msg.requestId, tool: msg.tool, input: msg.input, chatId: msg.chatId },
            ]);
            break;
          case "question_request":
            setQuestions((prev) => [
              ...prev,
              { requestId: msg.requestId, question: msg.question, options: msg.options, multiSelect: msg.multiSelect, chatId: msg.chatId },
            ]);
            break;
          case "usage":
            setUsage({ turnCostUsd: msg.turnCostUsd, costUsd: msg.costUsd, tokens: msg.tokens });
            break;
          case "chat_list":
            setChats(msg.chats);
            setActiveChatId(msg.activeChatId);
            break;
          case "chat_history": {
            activeChatRef.current = msg.chatId;
            setActiveChatId(msg.chatId);
            const persisted = msg.messages.map(persistedToChat);
            // Preserve the live tail of an in-flight turn: the open (streaming) assistant
            // bubble and still-running tool bubbles are persisted only when they finish,
            // so a plain reseed would drop them until the turn ends. Completed tools ARE
            // already in `persisted` (the host persists them at tool_execution_end).
            const prev = messagesByChat.current.get(msg.chatId) ?? [];
            const liveTail = prev.filter((m) => m.open || m.toolStatus === "running");
            const merged = liveTail.length ? [...persisted, ...liveTail] : persisted;
            messagesByChat.current.set(msg.chatId, merged);
            setMessages(merged);
            break; // approvals/questions are NOT cleared — they're per-chat and filtered on read
          }
          case "action_center_state":
            setActionCenter(msg.state);
            break;
          case "error":
            updateChat(msg.chatId ?? null, (prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "assistant", text: `⚠️ ${msg.message}` },
            ]);
            break;
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [url, token]);

  const send = useCallback((event: ClientEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }, []);

  const sendMessage = useCallback(
    (text: string, attachments?: ChannelFile[]) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      updateChat(activeChatId, (prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text: trimmed, ts: Date.now(), ...(attachments?.length ? { attachments } : {}) },
      ]);
      send({ type: "user_message", sessionId: sessionRef.current, text: trimmed, chatId: activeChatId ?? undefined, attachments });
    },
    [send, activeChatId],
  );

  const stop = useCallback(() => send({ type: "stop", chatId: activeChatId ?? undefined }), [send, activeChatId]);

  const uploadFile = useCallback(async (file: File): Promise<ChannelFile> => {
    const res = await authFetch(`${httpBase}/upload?name=${encodeURIComponent(file.name)}`, token, onUnauthorized, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    return (await res.json()) as ChannelFile;
  }, [httpBase, token, onUnauthorized]);

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
      const res = await authFetch(`${httpBase}/resolve?path=${encodeURIComponent(key)}`, token, onUnauthorized);
      if (!res.ok) return undefined;
      const file = (await res.json()) as ChannelFile;
      if (file.path) filesRef.current.set(file.path, file);
      filesRef.current.set(file.name, file);
      return file;
    } catch {
      return undefined;
    }
  }, [httpBase, token, onUnauthorized]);

  // Approvals/questions are per-chat (chatId is optional for back-compat): a
  // card with no chatId is treated as belonging to whatever chat is active so
  // it isn't silently dropped, and it stays visible across chat switches.
  const visibleApprovals = approvals.filter((a) => !a.chatId || a.chatId === activeChatId);
  const visibleQuestions = questions.filter((q) => !q.chatId || q.chatId === activeChatId);

  return { connected, state, messages, approvals: visibleApprovals, questions: visibleQuestions, usage, actionCenter, chats, activeChatId, createChat, selectChat, renameChat, deleteChat, saveChat, openActionChat, uploadFile, sendMessage, stop, respondQuestion, openFile, revealFile, resolveFile, registerPath, refreshActions, markAction, executeProposal, reviseProposal, respondApproval };
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
