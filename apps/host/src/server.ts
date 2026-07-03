/**
 * WebSocket server — the transport for the channel protocol. Each
 * connection is one session (one channel client: the web UI in Phase 1;
 * Telegram/Discord later are just more clients of the same protocol).
 */
import { WebSocketServer } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientEvent } from "@llm-wiki/protocol";
import { ChatManager } from "./core/agent-runner.ts";
import { ActionRevisionRequestedError, executeActionProposal, getActionItem, loadActionCenterState, markAction, reviseActionProposal } from "./core/action-center-service.ts";
import type { ActionCenterItem } from "@llm-wiki/protocol";
import { registerUserPath, resolveToken, saveUpload } from "./core/file-registry.ts";
import { usageStore } from "./core/usage-store.ts";
import { chatStore } from "./core/chat-store.ts";
import { Session, type Emit } from "./core/session.ts";
import { loadSystemStatus, setAutostart } from "./core/system-status.ts";
import type { HostConfig } from "./config.ts";

/** Origins allowed to talk to the host (the served UI itself + vite dev). */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // non-browser clients send no Origin
  const extra = (process.env.HOST_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = new Set([
    `http://127.0.0.1:${port}`, `http://localhost:${port}`,
    "http://127.0.0.1:5173", "http://localhost:5173",
    ...extra,
  ]);
  return allowed.has(origin);
}

function corsHeaders(origin: string | undefined, port: number): Record<string, string> {
  if (origin === undefined || !isAllowedOrigin(origin, port)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    Vary: "Origin",
  };
}
const MAX_UPLOAD = 25 * 1024 * 1024;
const WEB_DIST_DIR = process.env.HOST_STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function tryServeWebAsset(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  let pathname = "/";
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(400, cors);
    res.end("bad request");
    return true;
  }

  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const normalized = normalize(requested);
  const candidate = join(WEB_DIST_DIR, normalized);
  const safe = !relative(WEB_DIST_DIR, candidate).startsWith("..");
  const fallback = join(WEB_DIST_DIR, "index.html");
  const file = safe ? candidate : fallback;

  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Length": stat.size,
      ...cors,
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
    }
    return true;
  } catch {
    if (file !== fallback) {
      try {
        const stat = statSync(fallback);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": stat.size,
          ...cors,
        });
        if (req.method === "HEAD") {
          res.end();
        } else {
          createReadStream(fallback).on("error", () => res.destroy()).pipe(res);
        }
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/** HTTP routes: POST /upload, GET /usage (cost/token stats), GET /file/<token>. */
function handleHttp(config: HostConfig, req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  if (req.headers.origin !== undefined && !isAllowedOrigin(req.headers.origin, config.port)) {
    res.writeHead(403); res.end("forbidden origin"); return;
  }
  const CORS = corsHeaders(req.headers.origin, config.port);
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === "GET" && url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({ ok: true, port: config.port }));
    return;
  }
  if (req.method === "GET" && url.startsWith("/system/status")) {
    void loadSystemStatus(config).then((status) => {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(status));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }
  if (req.method === "POST" && url.startsWith("/system/autostart")) {
    void readRequestBody(req).then((raw) => {
      const body = raw ? JSON.parse(raw) as { enabled?: unknown } : {};
      const status = setAutostart(body.enabled === true);
      res.writeHead(status.detail && body.enabled === true && !status.enabled ? 400 : 200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(status));
    }).catch((err) => {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }
  if (req.method === "POST" && url.startsWith("/upload")) {
    const name = new URL(url, "http://x").searchParams.get("name") ?? "file";
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_UPLOAD) tooBig = true; else chunks.push(c); });
    req.on("error", () => { res.writeHead(500, CORS); res.end("upload error"); });
    req.on("end", () => {
      if (tooBig) { res.writeHead(413, CORS); res.end("file too large"); return; }
      const ref = saveUpload(name, Buffer.concat(chunks));
      if (!ref) { res.writeHead(500, CORS); res.end("upload failed"); return; }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(ref));
    });
    return;
  }
  if (url.startsWith("/usage")) {
    const body = JSON.stringify({ ...(usageStore().summary() as object), rates: config.gateway.cost });
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(body);
    return;
  }
  // Make a file-card path actionable on demand (register → return its ref).
  if (url.startsWith("/resolve")) {
    const path = new URL(url, "http://x").searchParams.get("path") ?? "";
    const ref = registerUserPath(path);
    if (!ref) { res.writeHead(404, CORS); res.end("not found or blocked"); return; }
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify(ref));
    return;
  }
  if (url.startsWith("/file/")) {
    const m = url.match(/^\/file\/([\w-]+)/);
    const entry = m ? resolveToken(m[1]) : null;
    if (!entry) { res.writeHead(404, { ...CORS }); res.end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": entry.ref.mime,
      "Content-Length": entry.ref.size,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(entry.ref.name)}`,
      ...CORS,
    });
    createReadStream(entry.path).on("error", () => res.destroy()).pipe(res);
    return;
  }
  if (tryServeWebAsset(req, res, CORS)) return;
  res.writeHead(404, CORS);
  res.end("not found");
}

export function startServer(config: HostConfig): WebSocketServer {
  const httpServer = createServer((req, res) => handleHttp(config, req, res));
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ req }: { req: IncomingMessage }) =>
      isAllowedOrigin(req.headers.origin, config.port),
  });

  // Startup housekeeping: drop unsaved temporary chats from previous runs.
  // Done once per process — NOT per connection (a second tab must not delete
  // the temporary action chats another connection is actively using).
  chatStore().purgeTemporary();

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

    // Per-action temporary "scratch" chats (open-in-chat / execute go here).
    const actionChats = new Map<number, string>();
    const ensureActionChat = (action: ActionCenterItem): string => {
      const existing = actionChats.get(action.id);
      if (existing && store.exists(existing)) return existing;
      const chat = store.createChat(`⚡ ${action.title}`.slice(0, 60), { temporary: true });
      actionChats.set(action.id, chat.id);
      return chat.id;
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
          void chats.runTurn(chatId, msg.text, msg.attachments).then(sendChatList);
          break;
        }
        case "stop":
          void chats.abort(msg.chatId ?? session.activeChatId ?? undefined);
          break;
        case "chat_list":
          sendChatList();
          break;
        case "chat_create": {
          const chat = store.createChat(msg.title, { temporary: msg.temporary });
          selectChat(chat.id);
          break;
        }
        case "chat_save":
          store.setTemporary(msg.chatId, false);
          sendChatList();
          break;
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
        case "action_open_in_chat": {
          const action = getActionItem(msg.id);
          if (!action) { emit({ type: "error", sessionId: session.id, message: `Action not found: ${msg.id}` }); break; }
          const chatId = ensureActionChat(action);
          selectChat(chatId);
          const prompt = `Apri l'action-center item ${action.id} "${action.title}". Leggilo con read_action, riassumimi il contesto e aiutami a decidere cosa fare.`;
          void chats.runTurn(chatId, prompt).then(sendChatList);
          break;
        }
        case "action_center_execute":
          void (async () => {
            const action = getActionItem(msg.id);
            const chatId = action ? ensureActionChat(action) : session.activeChatId ?? undefined;
            if (chatId) selectChat(chatId);
            emit({ type: "status", sessionId: session.id, ...(chatId ? { chatId } : {}), state: "running" });
            try {
              const state = await executeActionProposal({
                config,
                session,
                emit,
                actionId: msg.id,
                proposalId: msg.proposalId,
                chatId,
              });
              emit({ type: "action_center_state", sessionId: session.id, state });
            } catch (err) {
              if (err instanceof ActionRevisionRequestedError) {
                if (chatId) await chats.runTurn(chatId, err.prompt);
              } else {
                emit({ type: "error", sessionId: session.id, message: err instanceof Error ? err.message : String(err) });
              }
            } finally {
              emit({ type: "status", sessionId: session.id, ...(chatId ? { chatId } : {}), state: "idle" });
              sendChatList();
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
