/**
 * WebSocket server — the transport for the channel protocol. Each
 * connection is one session (one channel client: the web UI in Phase 1;
 * Telegram/Discord later are just more clients of the same protocol).
 */
import { WebSocketServer } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createReadStream, readFileSync, statSync, type Stats } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientEvent } from "@steward/protocol";
import { ChatManager } from "./core/agent-runner.ts";
import { ActionRevisionRequestedError, executeActionProposal, getActionItem, loadActionCenterState, markAction, reviseActionProposal, setPushRegistry } from "./core/action-center-service.ts";
import type { ActionCenterItem } from "@steward/protocol";
import { registerUserPath, resolveToken, saveUpload } from "./core/file-registry.ts";
import { usageStore } from "./core/usage-store.ts";
import { chatStore } from "./core/chat-store.ts";
import { Session, type Emit } from "./core/session.ts";
import { loadSystemStatus, setAutostart } from "./core/system-status.ts";
import { PushRegistry, type PushSubscriptionJSON } from "./core/push.ts";
import { pushSubscriptionsPath, type HostConfig } from "./config.ts";

/** Origins allowed to talk to the host: the served UI itself, plus the vite dev
 *  server — but the vite origins only outside production (the packaged app sets
 *  NODE_ENV=production), so a stray process on :5173 can't drive a shipped host. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // non-browser clients send no Origin
  const extra = (process.env.HOST_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const viteDev = process.env.NODE_ENV === "production"
    ? []
    : ["http://127.0.0.1:5173", "http://localhost:5173"];
  const allowed = new Set([
    `http://127.0.0.1:${port}`, `http://localhost:${port}`,
    ...viteDev,
    ...extra,
  ]);
  return allowed.has(origin);
}

/**
 * True when the browser's Origin matches the Host it connected to (a same-origin
 * request — the served page calling back to itself). This is what makes the phone
 * work over Tailscale without listing its address: the page loads from
 * `http://<mac-tailnet>:4317` and its WS/fetch Origin equals that Host. A
 * cross-site attacker's Origin differs from Host, so it stays rejected — and the
 * data channels also require the auth token regardless.
 */
export function originMatchesHost(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin || !hostHeader) return false;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
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
/** Constant-time compare; `timingSafeEqual` throws on a length mismatch, so guard that case first. */
function tokensEqual(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Auth check for the WS + HTTP data routes: the token may arrive as `?token=`
 * (WS URL, `<img src>`/`<a href>` for `/file/<t>`) or an `Authorization:
 * Bearer <token>` header (fetches). Either is accepted; missing/invalid → false.
 */
export function tokenOk(url: string | undefined, header: string | undefined, token: string): boolean {
  let fromQuery: string | null = null;
  try {
    fromQuery = new URL(url ?? "/", "http://x").searchParams.get("token");
  } catch {
    fromQuery = null;
  }
  const fromHeader = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const candidate = fromQuery ?? fromHeader;
  if (!candidate) return false;
  return tokensEqual(candidate, token);
}

const LOCALHOST_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Only the Mac's own browser (the packaged app, or dev on :5173) counts as localhost — a phone over Tailscale never matches. */
function isLocalhostRequest(req: IncomingMessage): boolean {
  return LOCALHOST_ADDRS.has(req.socket.remoteAddress ?? "");
}

/** HTTP routes that require a valid token (everything that reads/writes agent state or files). */
const DATA_ROUTE_PREFIXES = ["/usage", "/upload", "/file/", "/resolve", "/system/status", "/system/autostart", "/push/"];
function isDataRoute(url: string): boolean {
  return DATA_ROUTE_PREFIXES.some((p) => url.startsWith(p));
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

/**
 * Serve index.html. On localhost only, inject `window.__STEWARD_TOKEN__` so
 * the Mac's own browser auto-pairs (no manual pairing screen); a phone
 * (non-localhost) gets the plain page and pairs via the `/pair` QR.
 */
function serveIndexHtml(config: HostConfig, req: IncomingMessage, res: ServerResponse, cors: Record<string, string>, filePath: string): void {
  let html = readFileSync(filePath, "utf8");
  if (isLocalhostRequest(req)) {
    const inject = `<script>window.__STEWARD_TOKEN__=${JSON.stringify(config.authToken)}</script>`;
    html = html.includes("</head>") ? html.replace("</head>", `${inject}</head>`) : html;
  }
  const body = Buffer.from(html, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, ...cors });
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

function tryServeWebAsset(config: HostConfig, req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): boolean {
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
    if (extname(file) === ".html") {
      serveIndexHtml(config, req, res, cors, file);
      return true;
    }
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
        statSync(fallback);
        serveIndexHtml(config, req, res, cors, fallback);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * The gateway's `/rates` is a per-tier map (`{ "tier-5": { input, output, … } }`);
 * the Usage page wants the FLAT rate for THIS host's tier. Pick it out, falling
 * back to `fallback` (the flat `config.gateway.cost`) if the tier is absent.
 */
export function pickTierRates(ratesMap: unknown, tier: string, fallback: unknown): unknown {
  const flat = (ratesMap as Record<string, unknown> | null)?.[tier];
  return flat && typeof flat === "object" ? flat : fallback;
}

/**
 * Flat USD rates for the Usage page, fetched once from the gateway's `/rates`
 * (single source of truth) and cached for the process lifetime. Falls back to
 * `config.gateway.cost` (Pi's own registration cost) if the gateway is
 * unreachable/slow or doesn't know this tier, so `/usage` never blocks on it.
 */
let cachedRates: unknown | undefined;
async function gatewayRates(baseUrl: string, tier: string, fallback: unknown): Promise<unknown> {
  if (cachedRates !== undefined) return cachedRates;
  try {
    const origin = baseUrl.replace(/\/v1\/?$/, "");
    const res = await fetch(`${origin}/rates`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const flat = pickTierRates(await res.json(), tier, fallback);
      // only cache a real hit; on a miss keep trying next request
      if (flat !== fallback) return (cachedRates = flat);
    }
  } catch {
    // gateway down or timed out — fall back to the static config cost.
  }
  return fallback;
}

/** HTTP routes: POST /upload, GET /usage (cost/token stats), GET /file/<token>. */
function handleHttp(config: HostConfig, pushRegistry: PushRegistry, req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  if (
    req.headers.origin !== undefined &&
    !isAllowedOrigin(req.headers.origin, config.port) &&
    !originMatchesHost(req.headers.origin, req.headers.host)
  ) {
    res.writeHead(403); res.end("forbidden origin"); return;
  }
  const CORS = corsHeaders(req.headers.origin, config.port);
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === "GET" && url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({ ok: true, port: config.port }));
    return;
  }
  // Localhost-only: lets the System page fetch the token to render the pairing QR.
  // Never answered for a non-localhost (phone/Tailscale) caller.
  if (req.method === "GET" && url.startsWith("/pair")) {
    if (!isLocalhostRequest(req)) { res.writeHead(403, CORS); res.end("forbidden"); return; }
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({ token: config.authToken }));
    return;
  }
  if (isDataRoute(url) && !tokenOk(url, req.headers.authorization, config.authToken)) {
    res.writeHead(401, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (req.method === "GET" && url.startsWith("/push/vapid")) {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({ publicKey: config.vapid.publicKey }));
    return;
  }
  if (req.method === "POST" && url.startsWith("/push/subscribe")) {
    void readRequestBody(req).then((raw) => {
      const sub = raw ? (JSON.parse(raw) as PushSubscriptionJSON) : null;
      if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
        res.writeHead(400, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify({ error: "invalid subscription" }));
        return;
      }
      pushRegistry.subscribe(sub);
      res.writeHead(204, CORS);
      res.end();
    }).catch((err) => {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }
  if (req.method === "POST" && url.startsWith("/push/unsubscribe")) {
    void readRequestBody(req).then((raw) => {
      const body = raw ? (JSON.parse(raw) as { endpoint?: string }) : {};
      if (body.endpoint) pushRegistry.unsubscribe(body.endpoint);
      res.writeHead(204, CORS);
      res.end();
    }).catch((err) => {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
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
  if (url.startsWith("/usage") && req.method === "GET") {
    void gatewayRates(config.gateway.baseUrl, config.gateway.tier, config.gateway.cost).then((rates) => {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ ...(usageStore().summary() as object), rates }));
    });
    return;
  }
  // Make a file-card path actionable on demand (register → return its ref).
  if (url.startsWith("/resolve") && req.method === "GET") {
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
    let stat: Stats | undefined;
    try { stat = entry ? statSync(entry.path) : undefined; } catch { /* gone */ }
    if (!entry || !stat?.isFile()) { res.writeHead(404, CORS); res.end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": entry.ref.mime,
      "Content-Length": stat.size,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(entry.ref.name)}`,
      ...CORS,
    });
    createReadStream(entry.path).on("error", () => res.destroy()).pipe(res);
    return;
  }
  if (tryServeWebAsset(config, req, res, CORS)) return;
  res.writeHead(404, CORS);
  res.end("not found");
}

export function startServer(config: HostConfig): WebSocketServer {
  const pushRegistry = new PushRegistry(pushSubscriptionsPath());
  setPushRegistry(pushRegistry);
  // Two listeners: plain HTTP on localhost (the Mac's own WebView — a secure
  // context anyway, auto-pairs, keeps native "open/reveal" actions), and — when a
  // TLS cert+key are provided (e.g. `tailscale cert`) — HTTPS on all interfaces
  // for the phone over Tailscale. A secure context (https) is what unlocks service
  // workers + Web Push there; plain http stays localhost-only, never on the tailnet.
  const tlsCert = process.env.STEWARD_TLS_CERT;
  const tlsKey = process.env.STEWARD_TLS_KEY;
  const useTls = !!(tlsCert && tlsKey);
  const wss = new WebSocketServer({ noServer: true });
  const acceptUpgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const ok =
      (isAllowedOrigin(req.headers.origin, config.port) || originMatchesHost(req.headers.origin, req.headers.host)) &&
      tokenOk(req.url, req.headers.authorization, config.authToken);
    if (!ok) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };

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
    // Single-flight guard: a double-click must not run an action's steps (e.g. send_email) twice.
    const executingActions = new Set<number>();
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
          chats.dispose(msg.chatId);
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
          if (executingActions.has(msg.id)) {
            emit({ type: "error", sessionId: session.id, message: `Action ${msg.id} is already executing` });
            break;
          }
          executingActions.add(msg.id);
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
              executingActions.delete(msg.id);
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

  // HTTP for the Mac's own WebView — localhost only, never exposed on the tailnet.
  const httpServer = createServer((req, res) => handleHttp(config, pushRegistry, req, res));
  httpServer.on("upgrade", acceptUpgrade);
  httpServer.listen(config.port, "127.0.0.1", () => {
    console.log(`[host] http://127.0.0.1:${config.port} (localhost)`);
  });

  // HTTPS on all interfaces for the phone over Tailscale (secure context → push).
  if (useTls) {
    const tlsPort = Number(process.env.STEWARD_TLS_PORT ?? config.port + 1);
    const httpsServer = createHttpsServer(
      { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) },
      (req, res) => handleHttp(config, pushRegistry, req, res),
    );
    httpsServer.on("upgrade", acceptUpgrade);
    httpsServer.listen(tlsPort, "0.0.0.0", () => {
      console.log(`[host] https://0.0.0.0:${tlsPort} (Tailscale/phone)`);
    });
  }
  return wss;
}
