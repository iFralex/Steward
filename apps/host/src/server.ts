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
import { isRunning } from "./core/running-chats.ts";
import { auditLog, recordAudit, type AuditActor, type AuditRisk } from "@steward/audit-log";
import { ActionRevisionRequestedError, executeActionProposal, getActionAutomationSettings, getActionItem, loadActionCenterState, markAction, pollNewActionNotifications, reviseActionProposal, setActionAutomationEnabled, setPushRegistry } from "./core/action-center-service.ts";
import type { ActionCenterItem } from "@steward/protocol";
import { registerUserPath, resolveToken, saveUpload } from "./core/file-registry.ts";
import { usageLedger } from "@steward/usage-ledger";
import { chatStore } from "./core/chat-store.ts";
import { Session, type Emit } from "./core/session.ts";
import { loadSystemStatus, setAutostart } from "./core/system-status.ts";
import { PushRegistry, type PushSubscriptionJSON } from "./core/push.ts";
import { getNotificationLang, setNotificationLang } from "./core/notification-lang.ts";
import { notificationCopy } from "./core/notification-copy.ts";
import { sharedWatchEngine } from "./core/watch-runtime.ts";
import { pollAndDeliverWatchEvents } from "./core/watch-notification-service.ts";
import { pushSubscriptionsPath, type HostConfig } from "./config.ts";
import { SpeechUnavailableError, transcribeAudioPayload, type AudioPayload } from "./core/speech.ts";

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
const DATA_ROUTE_PREFIXES = ["/usage", "/audit", "/upload", "/file/", "/resolve", "/system/status", "/system/autostart", "/settings/notification-lang", "/settings/actions", "/push/", "/quick-send", "/transcribe"];
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

/**
 * Headless chat runner for /quick-send (iPhone Action button → Shortcut → POST):
 * no WebSocket client is attached, so events go nowhere and a gated write that
 * asks for approval simply times out (denied). One shared instance — turns are
 * serialized per chat by ChatManager's own queue.
 */
let quickRunner: ChatManager | null = null;
function getQuickRunner(config: HostConfig): ChatManager {
  if (!quickRunner) {
    const noop: Emit = () => {};
    quickRunner = new ChatManager(config, new Session(noop, config.approvalTimeoutMs), noop);
  }
  return quickRunner;
}

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

type QuickSendBody = { text?: unknown; audio?: AudioPayload };

async function textFromQuickSendBody(config: HostConfig, body: QuickSendBody): Promise<string> {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text) return text;
  if (body.audio && typeof body.audio === "object") return transcribeAudioPayload(config, body.audio);
  return "";
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

interface FlatRates { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * Attribute token-kind costs across tiers: each tier's tokens × that tier's
 * rates (USD per 1M), summed. Unknown tiers (e.g. local-embed) fall back to
 * the flat config cost so the split stays sane if the gateway map is stale.
 */
export function costByKindFromTiers(
  byTier: { tier: string; input: number; output: number; cacheRead: number; cacheWrite: number }[],
  ratesMap: Record<string, FlatRates> | null,
  fallback: FlatRates,
): FlatRates {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const t of byTier) {
    const r = ratesMap?.[t.tier] ?? fallback;
    out.input += (t.input * r.input) / 1_000_000;
    out.output += (t.output * r.output) / 1_000_000;
    out.cacheRead += (t.cacheRead * r.cacheRead) / 1_000_000;
    out.cacheWrite += (t.cacheWrite * r.cacheWrite) / 1_000_000;
  }
  return out;
}

/** Full per-tier rates map from the gateway, cached for the process lifetime. */
let cachedRatesMap: Record<string, FlatRates> | null | undefined;
async function gatewayRatesMap(baseUrl: string): Promise<Record<string, FlatRates> | null> {
  if (cachedRatesMap !== undefined) return cachedRatesMap;
  try {
    const origin = baseUrl.replace(/\/v1\/?$/, "");
    const res = await fetch(`${origin}/rates`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return (cachedRatesMap = await res.json() as Record<string, FlatRates>);
  } catch {
    // gateway down or timed out — fall back to the static config cost.
  }
  return null; // don't cache a miss; retry next request
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
      recordAudit({
        actor: "system",
        eventType: "push.subscribe",
        risk: "low",
        summary: "Push subscription registered",
        payload: { endpoint: sub.endpoint },
      });
      res.writeHead(204, CORS);
      res.end();
    }).catch((err) => {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }
  // Delayed test push: fire-and-forget so the user can background/close the
  // app and verify real delivery (not just the in-page permission state).
  if (req.method === "POST" && url.startsWith("/push/test")) {
    recordAudit({ actor: "user", eventType: "push.test", risk: "low", summary: "Push test requested" });
    res.writeHead(202, CORS);
    res.end();
    setTimeout(() => {
      void pushRegistry.sendAll({
        title: "Steward",
        body: notificationCopy(getNotificationLang()).testPush,
        tag: "push-test",
      }).catch(() => { /* best-effort */ });
    }, 15_000);
    return;
  }
  if (req.method === "POST" && url.startsWith("/push/unsubscribe")) {
    void readRequestBody(req).then((raw) => {
      const body = raw ? (JSON.parse(raw) as { endpoint?: string }) : {};
      if (body.endpoint) pushRegistry.unsubscribe(body.endpoint);
      recordAudit({
        actor: "system",
        eventType: "push.unsubscribe",
        risk: "low",
        summary: "Push subscription removed",
        payload: { endpoint: body.endpoint },
      });
      res.writeHead(204, CORS);
      res.end();
    }).catch((err) => {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }
  if (req.method === "POST" && url.startsWith("/transcribe")) {
    void readRequestBody(req).then(async (raw) => {
      const body = raw ? (JSON.parse(raw) as { audio?: AudioPayload }) : {};
      if (!body.audio || typeof body.audio !== "object") {
        res.writeHead(400, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify({ error: "audio is required" }));
        return;
      }
      const text = await transcribeAudioPayload(config, body.audio);
      recordAudit({
        actor: "host",
        eventType: "speech.transcribed",
        risk: "low",
        summary: "Audio transcribed",
        ok: true,
        payload: { text, mimeType: body.audio.mimeType, filename: body.audio.filename },
      });
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ text }));
    }).catch((err) => {
      console.error(`[quick-send] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      const status = err instanceof SpeechUnavailableError ? 503 : 400;
      recordAudit({
        actor: "host",
        eventType: "speech.failed",
        risk: "medium",
        summary: err instanceof Error ? err.message : String(err),
        ok: false,
      });
      res.writeHead(status, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }
  // Quick message from outside the app (iPhone Action button via Shortcuts):
  // creates a fresh chat, runs the turn headless, then pushes the reply with
  // the chatId so tapping the notification lands on that chat.
  if (req.method === "POST" && url.startsWith("/quick-send")) {
    void readRequestBody(req).then(async (raw) => {
      const body = raw ? (JSON.parse(raw) as QuickSendBody) : {};
      const text = await textFromQuickSendBody(config, body);
      const chat = chatStore().createChat();
      recordAudit({
        actor: "user",
        eventType: "quick_send.created",
        risk: "low",
        summary: text ? text.slice(0, 180) : "Quick-send created an empty chat",
        chatId: chat.id,
        payload: { text },
      });
      res.writeHead(202, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ chatId: chat.id }));
      // No text (e.g. the Shortcut prompt was left empty): just hand back a
      // fresh chat — the push tap opens the app right on it, ready to type.
      if (!text) {
        void pushRegistry.sendAll({
          title: "Steward",
          body: notificationCopy(getNotificationLang()).newChatReady,
          tag: `chat-${chat.id}`,
          chatId: chat.id,
          type: "chat-open",
        }).catch(() => { /* best-effort */ });
        return;
      }
      void getQuickRunner(config)
        .runTurn(chat.id, text)
        .then(() => {
          const reply = [...chatStore().getMessages(chat.id)].reverse().find((m) => m.role === "assistant")?.text ?? "";
          return pushRegistry.sendAll({
            title: "Steward",
            body: reply ? reply.slice(0, 140) : notificationCopy(getNotificationLang()).replyReady,
            tag: `chat-${chat.id}`,
            chatId: chat.id,
            type: "chat-reply",
          });
        })
        .catch(() => { /* best-effort: the chat + transcript persist regardless */ });
    }).catch((err) => {
      const status = err instanceof SpeechUnavailableError ? 503 : 400;
      res.writeHead(status, { "Content-Type": "application/json", ...CORS });
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
      recordAudit({
        actor: "user",
        eventType: "system.autostart",
        risk: "medium",
        summary: `${body.enabled === true ? "Enabled" : "Disabled"} launch at login`,
        ok: !status.detail || status.enabled === (body.enabled === true),
        payload: status,
      });
      res.writeHead(status.detail && body.enabled === true && !status.enabled ? 400 : 200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(status));
    }).catch((err) => {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }
  if (req.method === "GET" && url.startsWith("/settings/actions")) {
    try {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(getActionAutomationSettings()));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }
  if (req.method === "POST" && url.startsWith("/settings/actions")) {
    void readRequestBody(req).then((raw) => {
      const body = raw ? JSON.parse(raw) as { enabled?: unknown } : {};
      if (typeof body.enabled !== "boolean") {
        res.writeHead(400, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify({ error: "enabled must be a boolean" }));
        return;
      }
      const settings = setActionAutomationEnabled(body.enabled);
      recordAudit({
        actor: "user",
        eventType: "settings.actions_automation",
        risk: "low",
        summary: `${settings.enabled ? "Enabled" : "Disabled"} automatic Actions`,
        payload: settings,
      });
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(settings));
    }).catch((err) => {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }
  // Syncs the language used for server-generated push copy (test/new-chat/reply
  // notifications) with whichever device last changed it in the System page —
  // one shared setting, since push goes to every registered device regardless.
  if (req.method === "POST" && url.startsWith("/settings/notification-lang")) {
    void readRequestBody(req).then((raw) => {
      const body = raw ? JSON.parse(raw) as { lang?: unknown } : {};
      if (body.lang !== "en" && body.lang !== "it") {
        res.writeHead(400, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify({ error: "lang must be \"en\" or \"it\"" }));
        return;
      }
      setNotificationLang(body.lang);
      recordAudit({
        actor: "user",
        eventType: "settings.notification_lang",
        risk: "low",
        summary: `Notification language set to ${body.lang}`,
        payload: { lang: body.lang },
      });
      res.writeHead(204, CORS);
      res.end();
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
      recordAudit({
        actor: "user",
        eventType: "file.uploaded",
        risk: "medium",
        summary: `Uploaded ${ref.name}`,
        ok: true,
        payload: ref,
        sourceRefs: [{ type: "file", id: ref.token, path: ref.path, label: ref.name }],
      });
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(ref));
    });
    return;
  }
  if (url.startsWith("/audit") && req.method === "GET") {
    try {
      const parsed = new URL(url, "http://x");
      const limit = parsed.searchParams.get("limit");
      const cursor = parsed.searchParams.get("cursor");
      const since = parsed.searchParams.get("since");
      const until = parsed.searchParams.get("until");
      const actionId = parsed.searchParams.get("actionId");
      const actor = parsed.searchParams.get("actor");
      const risk = parsed.searchParams.get("risk");
      const page = auditLog().query({
        limit: limit ? Number(limit) : undefined,
        cursor: cursor ? Number(cursor) : undefined,
        since: since ? Number(since) : undefined,
        until: until ? Number(until) : undefined,
        actionId: actionId ? Number(actionId) : undefined,
        actor: isAuditActor(actor) ? actor : undefined,
        risk: isAuditRisk(risk) ? risk : undefined,
        eventType: parsed.searchParams.get("eventType") ?? undefined,
        chatId: parsed.searchParams.get("chatId") ?? undefined,
        toolName: parsed.searchParams.get("toolName") ?? undefined,
        q: parsed.searchParams.get("q") ?? undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(page));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }
  if (url.startsWith("/usage") && req.method === "GET") {
    const daysParam = new URL(url, "http://x").searchParams.get("days") ?? "30";
    const days = daysParam === "all" ? undefined : Math.max(1, Number(daysParam) || 30);
    void gatewayRatesMap(config.gateway.baseUrl).then((ratesMap) => {
      const summary = usageLedger().summary(days);
      const costByKind = costByKindFromTiers(summary.byTier, ratesMap, config.gateway.cost);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ ...summary, costByKind }));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }
  // Make a file-card path actionable on demand (register → return its ref).
  if (url.startsWith("/resolve") && req.method === "GET") {
    const path = new URL(url, "http://x").searchParams.get("path") ?? "";
    const ref = registerUserPath(path);
    if (!ref) { res.writeHead(404, CORS); res.end("not found or blocked"); return; }
    recordAudit({
      actor: "user",
      eventType: "file.registered",
      risk: "medium",
      summary: `Registered file ${ref.name}`,
      ok: true,
      payload: { path, ref },
      sourceRefs: [{ type: "file", id: ref.token, path: ref.path, label: ref.name }],
    });
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
    recordAudit({
      actor: "user",
      eventType: "file.served",
      risk: "medium",
      summary: `Served file ${entry.ref.name}`,
      ok: true,
      payload: entry.ref,
      sourceRefs: [{ type: "file", id: entry.ref.token, path: entry.path, label: entry.ref.name }],
    });
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

function isAuditActor(value: string | null): value is AuditActor {
  return value === "user" || value === "assistant" || value === "host" || value === "scheduler" || value === "tool" || value === "system";
}

function isAuditRisk(value: string | null): value is AuditRisk {
  return value === "low" || value === "medium" || value === "high";
}

export function startServer(config: HostConfig): WebSocketServer {
  const pushRegistry = new PushRegistry(pushSubscriptionsPath());
  setPushRegistry(pushRegistry);
  // The scheduler writes Actions in a separate process. Polling this local
  // SQLite DB lets the host push them even when no browser/PWA is connected.
  pollNewActionNotifications();
  const actionPushPollMs = Math.max(1_000, Number(process.env.ACTION_PUSH_POLL_MS ?? 15_000));
  const actionPushTimer = setInterval(pollNewActionNotifications, actionPushPollMs);
  actionPushTimer.unref();
  const pollWatches = () => pollAndDeliverWatchEvents({ engine: sharedWatchEngine(), runner: getQuickRunner(config), push: pushRegistry });
  void pollWatches();
  const watchPollMs = Math.max(15_000, Number(process.env.WATCH_POLL_MS ?? 45_000));
  const watchTimer = setInterval(() => void pollWatches(), watchPollMs);
  watchTimer.unref();
  // Two listeners: plain HTTP on localhost (the Mac's own WebView — a secure
  // context anyway, auto-pairs, keeps native "open/reveal" actions), and — when a
  // TLS cert+key are provided (e.g. `tailscale cert`) — HTTPS on all interfaces
  // for the phone over Tailscale. A secure context (https) is what unlocks service
  // workers + Web Push there; plain http stays localhost-only, never on the tailnet.
  const tlsCert = process.env.STEWARD_TLS_CERT;
  const tlsKey = process.env.STEWARD_TLS_KEY;
  const useTls = !!(tlsCert && tlsKey);
  const wss = new WebSocketServer({ noServer: true });
  wss.once("close", () => {
    clearInterval(actionPushTimer);
    clearInterval(watchTimer);
  });
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
    recordAudit({
      actor: "system",
      eventType: "session.connected",
      risk: "low",
      summary: "Client connected",
      sessionId: session.id,
    });

    const sendChatList = () => {
      emit({ type: "chat_list", chats: store.listChats(), activeChatId: session.activeChatId });
    };
    const selectChat = (chatId: string) => {
      if (!store.exists(chatId)) return;
      session.activeChatId = chatId;
      emit({ type: "chat_history", chatId, messages: store.getMessages(chatId) });
      // A turn on this chat may be running on a completely different
      // ChatManager (another connection, or /quick-send's headless runner) —
      // reflect the shared registry so this connection's UI shows it too,
      // instead of looking stuck until a later reload happens to catch it done.
      emit({ type: "status", sessionId: session.id, chatId, state: isRunning(chatId) ? "running" : "idle" });
      sendChatList();
      recordAudit({
        actor: "user",
        eventType: "chat.selected",
        risk: "low",
        summary: `Selected chat ${chatId}`,
        sessionId: session.id,
        chatId,
      });
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
      recordAudit({
        actor: "system",
        eventType: "session.disconnected",
        risk: "low",
        summary: "Client disconnected",
        sessionId: session.id,
        chatId: session.activeChatId,
      });
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
          recordAudit({
            actor: "user",
            eventType: "chat.created",
            risk: "low",
            summary: `Created chat ${chat.title}`,
            sessionId: session.id,
            chatId: chat.id,
            payload: { title: msg.title, temporary: msg.temporary },
          });
          selectChat(chat.id);
          break;
        }
        case "chat_save":
          store.setTemporary(msg.chatId, false);
          recordAudit({
            actor: "user",
            eventType: "chat.saved",
            risk: "low",
            summary: `Saved chat ${msg.chatId}`,
            sessionId: session.id,
            chatId: msg.chatId,
          });
          sendChatList();
          break;
        case "chat_select":
          selectChat(msg.chatId);
          break;
        case "chat_rename":
          store.rename(msg.chatId, msg.title);
          recordAudit({
            actor: "user",
            eventType: "chat.renamed",
            risk: "low",
            summary: `Renamed chat to ${msg.title}`,
            sessionId: session.id,
            chatId: msg.chatId,
            payload: { title: msg.title },
          });
          sendChatList();
          break;
        case "chat_delete": {
          chats.dispose(msg.chatId);
          store.deleteChat(msg.chatId);
          recordAudit({
            actor: "user",
            eventType: "chat.deleted",
            risk: "medium",
            summary: `Deleted chat ${msg.chatId}`,
            sessionId: session.id,
            chatId: msg.chatId,
          });
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
          if (entry) {
            recordAudit({
              actor: "user",
              eventType: "file.opened",
              risk: "medium",
              summary: `Opened file ${entry.ref.name}`,
              sessionId: session.id,
              chatId: session.activeChatId,
              payload: entry.ref,
              sourceRefs: [{ type: "file", id: entry.ref.token, path: entry.path, label: entry.ref.name }],
            });
            execFile("/usr/bin/open", [entry.path], () => {});
          }
          break;
        }
        case "reveal_file": {
          const entry = resolveToken(msg.token);
          if (entry) {
            recordAudit({
              actor: "user",
              eventType: "file.revealed",
              risk: "medium",
              summary: `Revealed file ${entry.ref.name}`,
              sessionId: session.id,
              chatId: session.activeChatId,
              payload: entry.ref,
              sourceRefs: [{ type: "file", id: entry.ref.token, path: entry.path, label: entry.ref.name }],
            });
            execFile("/usr/bin/open", ["-R", entry.path], () => {});
          }
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
          recordAudit({
            actor: "user",
            eventType: "action.marked",
            risk: "low",
            summary: `Action ${msg.id} marked ${msg.status}`,
            sessionId: session.id,
            actionId: msg.id,
            payload: { status: msg.status },
          });
          emit({ type: "action_center_state", sessionId: session.id, state: markAction(msg.id, msg.status) });
          break;
        case "action_open_in_chat": {
          const action = getActionItem(msg.id);
          if (!action) { emit({ type: "error", sessionId: session.id, message: `Action not found: ${msg.id}` }); break; }
          recordAudit({
            actor: "user",
            eventType: "action.opened_in_chat",
            risk: "low",
            summary: action.title,
            sessionId: session.id,
            actionId: action.id,
            payload: action,
          });
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
          recordAudit({
            actor: "user",
            eventType: "action.execute_requested",
            risk: "high",
            summary: `Execute action ${msg.id}`,
            sessionId: session.id,
            actionId: msg.id,
            payload: { proposalId: msg.proposalId },
          });
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
              recordAudit({
                actor: "host",
                eventType: "action.executed",
                risk: "high",
                summary: `Executed action ${msg.id}`,
                sessionId: session.id,
                chatId,
                actionId: msg.id,
                ok: true,
                payload: { proposalId: msg.proposalId },
              });
              emit({ type: "action_center_state", sessionId: session.id, state });
            } catch (err) {
              if (err instanceof ActionRevisionRequestedError) {
                recordAudit({
                  actor: "user",
                  eventType: "action.revision_requested",
                  risk: "medium",
                  summary: `Revision requested for action ${msg.id}`,
                  sessionId: session.id,
                  chatId,
                  actionId: msg.id,
                  payload: { proposalId: msg.proposalId },
                });
                if (chatId) await chats.runTurn(chatId, err.prompt);
              } else {
                recordAudit({
                  actor: "host",
                  eventType: "action.execute_failed",
                  risk: "high",
                  summary: err instanceof Error ? err.message : String(err),
                  sessionId: session.id,
                  chatId,
                  actionId: msg.id,
                  ok: false,
                  payload: { proposalId: msg.proposalId },
                });
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
          recordAudit({
            actor: "user",
            eventType: "action.revise_requested",
            risk: "medium",
            summary: msg.instruction.slice(0, 180),
            sessionId: session.id,
            actionId: msg.id,
            payload: { proposalId: msg.proposalId, instruction: msg.instruction },
          });
          void (async () => {
            emit({ type: "status", sessionId: session.id, state: "running" });
            try {
              const state = await reviseActionProposal({
                config,
                actionId: msg.id,
                proposalId: msg.proposalId,
                instruction: msg.instruction,
              });
              recordAudit({
                actor: "assistant",
                eventType: "action.revised",
                risk: "medium",
                summary: `Revised action ${msg.id}`,
                sessionId: session.id,
                actionId: msg.id,
                ok: true,
                payload: { proposalId: msg.proposalId },
              });
              emit({ type: "action_center_state", sessionId: session.id, state });
            } catch (err) {
              recordAudit({
                actor: "host",
                eventType: "action.revise_failed",
                risk: "medium",
                summary: err instanceof Error ? err.message : String(err),
                sessionId: session.id,
                actionId: msg.id,
                ok: false,
                payload: { proposalId: msg.proposalId },
              });
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
