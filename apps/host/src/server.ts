/**
 * WebSocket server — the transport for the channel protocol. Each
 * connection is one session (one channel client: the web UI in Phase 1;
 * Telegram/Discord later are just more clients of the same protocol).
 */
import { WebSocketServer } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import type { ClientEvent } from "@llm-wiki/protocol";
import { ChatManager } from "./core/agent-runner.ts";
import { ActionRevisionRequestedError, executeActionProposal, loadActionCenterState, markAction, reviseActionProposal } from "./core/action-center-service.ts";
import { resolveToken } from "./core/file-registry.ts";
import { usageStore } from "./core/usage-store.ts";
import { chatStore } from "./core/chat-store.ts";
import { Session, type Emit } from "./core/session.ts";
import type { HostConfig } from "./config.ts";

/** HTTP routes: GET /usage (JSON cost/token stats) and GET /file/<token>. */
function handleHttp(config: HostConfig, req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  if (url.startsWith("/usage")) {
    const body = JSON.stringify({ ...(usageStore().summary() as object), rates: config.gateway.cost });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(body);
    return;
  }
  const m = url.match(/^\/file\/([\w-]+)/);
  const entry = m ? resolveToken(m[1]) : null;
  if (!entry) { res.writeHead(404, { "Access-Control-Allow-Origin": "*" }); res.end("not found"); return; }
  res.writeHead(200, {
    "Content-Type": entry.ref.mime,
    "Content-Length": entry.ref.size,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(entry.ref.name)}`,
    "Access-Control-Allow-Origin": "*",
  });
  createReadStream(entry.path).on("error", () => res.destroy()).pipe(res);
}

export function startServer(config: HostConfig): WebSocketServer {
  const httpServer = createServer((req, res) => handleHttp(config, req, res));
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    const emit: Emit = (event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    };
    const session = new Session(emit, config.approvalTimeoutMs);
    const chats = new ChatManager(config, session, emit);
    const store = chatStore();

    const sendChatList = () => {
      emit({ type: "chat_list", chats: store.listChats(), activeChatId: session.activeChatId });
    };
    const selectChat = (chatId: string) => {
      if (!store.exists(chatId)) return;
      session.activeChatId = chatId;
      emit({ type: "chat_history", chatId, messages: store.getMessages(chatId) });
      sendChatList();
    };

    emit({ type: "status", sessionId: session.id, state: "idle" });
    emit({ type: "action_center_state", sessionId: session.id, state: loadActionCenterState() });
    // Restore (or seed) the chat list; focus the most-recent chat.
    const existing = store.listChats();
    const focus = existing[0] ?? store.createChat();
    selectChat(focus.id);

    ws.on("close", () => {
      session.closed = true;
      void chats.close();
      void session.directBridge?.close();
    });

    ws.on("message", (data) => {
      let msg: ClientEvent;
      try {
        msg = JSON.parse(data.toString()) as ClientEvent;
      } catch {
        emit({ type: "error", message: "invalid JSON" });
        return;
      }
      switch (msg.type) {
        case "user_message": {
          const chatId = msg.chatId ?? session.activeChatId;
          if (!chatId || !store.exists(chatId)) { emit({ type: "error", sessionId: session.id, message: "no active chat" }); break; }
          session.activeChatId = chatId;
          void chats.runTurn(chatId, msg.text).then(sendChatList);
          break;
        }
        case "chat_list":
          sendChatList();
          break;
        case "chat_create": {
          const chat = store.createChat(msg.title);
          selectChat(chat.id);
          break;
        }
        case "chat_select":
          selectChat(msg.chatId);
          break;
        case "chat_rename":
          store.rename(msg.chatId, msg.title);
          sendChatList();
          break;
        case "chat_delete": {
          store.deleteChat(msg.chatId);
          if (session.activeChatId === msg.chatId) {
            const remaining = store.listChats();
            const next = remaining[0] ?? store.createChat();
            selectChat(next.id);
          } else {
            sendChatList();
          }
          break;
        }
        case "approval_decision":
          session.resolveApproval(msg.requestId, {
            decision: msg.decision,
            note: msg.note,
            editedInput: msg.editedInput,
          });
          break;
        case "question_response":
          session.resolveQuestion(msg.requestId, msg.selected);
          break;
        case "open_file": {
          const entry = resolveToken(msg.token);
          if (entry) execFile("/usr/bin/open", [entry.path], () => {});
          break;
        }
        case "reveal_file": {
          const entry = resolveToken(msg.token);
          if (entry) execFile("/usr/bin/open", ["-R", entry.path], () => {});
          break;
        }
        case "action_center_refresh":
          emit({
            type: "action_center_state",
            sessionId: session.id,
            state: loadActionCenterState({ includeDone: msg.includeDone, limit: msg.limit }),
          });
          break;
        case "action_center_mark":
          emit({ type: "action_center_state", sessionId: session.id, state: markAction(msg.id, msg.status) });
          break;
        case "action_center_execute":
          void (async () => {
            emit({ type: "status", sessionId: session.id, state: "running" });
            try {
              const state = await executeActionProposal({
                config,
                session,
                emit,
                actionId: msg.id,
                proposalId: msg.proposalId,
              });
              emit({ type: "action_center_state", sessionId: session.id, state });
            } catch (err) {
              if (err instanceof ActionRevisionRequestedError) {
                if (session.activeChatId) await chats.runTurn(session.activeChatId, err.prompt);
              } else {
                emit({ type: "error", sessionId: session.id, message: err instanceof Error ? err.message : String(err) });
              }
            } finally {
              emit({ type: "status", sessionId: session.id, state: "idle" });
            }
          })();
          break;
        case "action_center_revise":
          void (async () => {
            emit({ type: "status", sessionId: session.id, state: "running" });
            try {
              const state = await reviseActionProposal({
                config,
                actionId: msg.id,
                proposalId: msg.proposalId,
                instruction: msg.instruction,
              });
              emit({ type: "action_center_state", sessionId: session.id, state });
            } catch (err) {
              emit({ type: "error", sessionId: session.id, message: err instanceof Error ? err.message : String(err) });
            } finally {
              emit({ type: "status", sessionId: session.id, state: "idle" });
            }
          })();
          break;
      }
    });
  });

  httpServer.listen(config.port, "127.0.0.1", () => {
    console.log(`[host] WebSocket listening on ws://127.0.0.1:${config.port} (files at http://127.0.0.1:${config.port}/file/<token>)`);
  });
  return wss;
}
