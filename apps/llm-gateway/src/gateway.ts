import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { usageLedger } from "@steward/usage-ledger";
import { USAGE_ACTION_HEADER, USAGE_SERVICE_HEADER, USAGE_SESSION_HEADER, USAGE_UNKNOWN } from "@steward/protocol";

type Json = Record<string, unknown>;
type GatewayModel = {
  provider: string;
  model: string;
  apiKey?: string;
  customHost?: string;
};

loadDotEnv(new URL("../.env", import.meta.url));

const PORT = Number(process.env.GATEWAY_PORT ?? 4000);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

function loadDotEnv(url: URL): void {
  const path = fileURLToPath(url);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export const models: Record<string, GatewayModel> = {
  "tier-1": { provider: "ollama", model: "llama3.2:1b", customHost: "http://127.0.0.1:11434" },
  "tier-2": { provider: "deepseek", model: "deepseek-v4-flash", apiKey: DEEPSEEK_API_KEY },
  "tier-3": { provider: "deepseek", model: "deepseek-v4-flash", apiKey: DEEPSEEK_API_KEY },
  "tier-4": { provider: "deepseek", model: "deepseek-v4-flash", apiKey: DEEPSEEK_API_KEY },
  "tier-5": { provider: "deepseek", model: "deepseek-v4-flash", apiKey: DEEPSEEK_API_KEY },
  "tier-6": { provider: "deepseek", model: "deepseek-v4-pro", apiKey: DEEPSEEK_API_KEY },
  "local-embed": { provider: "ollama", model: "bge-m3", customHost: "http://127.0.0.1:11434" },
};

export const fallbackOrder: Record<string, string[]> = {
  "tier-2": ["tier-2", "tier-3", "tier-4", "tier-5", "tier-6"],
  "tier-3": ["tier-3", "tier-4", "tier-5", "tier-6", "tier-2"],
  "tier-4": ["tier-4", "tier-5", "tier-6", "tier-3", "tier-2"],
  "tier-5": ["tier-5", "tier-6", "tier-4", "tier-3", "tier-2"],
  "tier-6": ["tier-6", "tier-5", "tier-4", "tier-3", "tier-2"],
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** USD per 1M tokens per tier — single source of truth for client cost display.
 *  Verified against DeepSeek's official pricing (V4 Flash / V4 Pro, 2026). */
export const rates: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "tier-1": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "tier-2": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  "tier-3": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  "tier-4": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  "tier-5": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  "tier-6": { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435 },
};

interface CallMeta {
  service: string;
  action: string;
  sessionId: string | null;
  t0: number;
  tierRequested: string;
}

function callMeta(req: IncomingMessage, body: Json): CallMeta {
  const h = (name: string): string | null => {
    const v = req.headers[name];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return {
    service: h(USAGE_SERVICE_HEADER) ?? USAGE_UNKNOWN,
    action: h(USAGE_ACTION_HEADER) ?? USAGE_UNKNOWN,
    sessionId: h(USAGE_SESSION_HEADER),
    t0: Date.now(),
    tierRequested: typeof body.model === "string" ? body.model : "",
  };
}

/** Normalize an OpenAI-compatible usage block. DeepSeek reports cache hits as
 *  prompt_cache_hit_tokens; newer providers as prompt_tokens_details.cached_tokens.
 *  Embeddings responses have prompt_tokens only. */
export function tokensFromUsage(usage: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const u = usage as { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  const prompt = typeof u?.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
  return {
    input: Math.max(0, prompt - cacheRead),
    output: typeof u?.completion_tokens === "number" ? u.completion_tokens : 0,
    cacheRead,
    cacheWrite: 0,
  };
}

/** Best-effort ledger write — metering must never break an LLM call. */
function recordCall(meta: CallMeta, servedTier: string | null, model: string, status: number, ok: boolean, usage: unknown): void {
  try {
    const t = tokensFromUsage(usage);
    const r = servedTier ? rates[servedTier] : undefined;
    const cost = r ? (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + t.cacheWrite * r.cacheWrite) / 1_000_000 : 0;
    usageLedger().recordLlmCall({
      ts: Date.now(), service: meta.service, action: meta.action, sessionId: meta.sessionId,
      tier: servedTier ?? meta.tierRequested, model,
      inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite,
      costUsd: cost, durationMs: Date.now() - meta.t0, ok, status,
    });
  } catch (err) {
    console.warn(`[llm-gateway] usage ledger write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Only availability failures are worth trying another tier; a 4xx is deterministic. */
export function shouldFallback(status: number): boolean {
  return status === 429 || status >= 500;
}

export function attemptsFor(model: string): { name: string; target: GatewayModel }[] {
  const names = fallbackOrder[model] ?? [model];
  return names.flatMap((name) => (models[name] ? [{ name, target: models[name] }] : []));
}

/** Base URL of a provider's OpenAI-compatible API. */
function directOpenAIBaseUrl(target: GatewayModel): string | undefined {
  if (target.provider === "deepseek") return process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
  if (target.customHost) return `${target.customHost.replace(/\/$/, "")}/v1`;
  return undefined;
}

async function callProvider(baseUrl: string, path: string, body: Json, target: GatewayModel): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
  const timeoutMs = Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS ?? 120_000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(prepareProviderBody(body, target)),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function prepareProviderBody(body: Json, target: GatewayModel): Json {
  const next: Json = { ...body, model: target.model };
  if (target.provider !== "deepseek") return next;

  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((message) => {
      if (!message || typeof message !== "object") return message;
      const msg = { ...(message as Json) };
      if (msg.role === "developer") msg.role = "system";
      return msg;
    });
  }

  delete next.store;
  delete next.reasoning_effort;
  if (Array.isArray(next.tools) && next.tools.length > 0) {
    next.thinking = { type: "disabled" };
  }
  return next;
}

async function proxyJson(path: string, body: Json, res: ServerResponse, meta: CallMeta): Promise<void> {
  const requestedModel = typeof body.model === "string" ? body.model : "";
  const attempts = attemptsFor(requestedModel);
  if (attempts.length === 0) {
    json(res, 400, { error: { message: `Unknown gateway model: ${requestedModel}`, type: "invalid_request_error" } });
    return;
  }

  let lastStatus = 502;
  let lastText = "";
  for (const { name, target } of attempts) {
    const base = directOpenAIBaseUrl(target);
    if (!base) { lastText = `no route for provider ${target.provider}`; continue; }
    try {
      const upstream = await callProvider(base, path, body, target);
      const text = await upstream.text();
      if (upstream.ok) {
        let parsed: { usage?: unknown; model?: unknown } = {};
        try { parsed = JSON.parse(text) as typeof parsed; } catch { /* pass-through body untouched */ }
        recordCall(meta, name, typeof parsed.model === "string" ? parsed.model : target.model, upstream.status, true, parsed.usage ?? null);
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(text);
        return;
      }
      if (!shouldFallback(upstream.status)) {
        recordCall(meta, name, target.model, upstream.status, false, null);
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(text);
        return;
      }
      lastStatus = upstream.status;
      lastText = text;
    } catch (err) {
      lastStatus = 502;
      lastText = err instanceof Error ? err.message : String(err);
    }
  }

  recordCall(meta, null, "", lastStatus, false, null);
  json(res, lastStatus, {
    error: {
      message: `All gateway attempts failed for ${requestedModel}: ${lastText.slice(0, 500)}`,
      type: "gateway_error",
    },
  });
}

// `meta` is threaded through but unused until Task 4 wires up streaming metering.
async function proxyStream(path: string, body: Json, res: ServerResponse, meta: CallMeta): Promise<void> {
  const requestedModel = typeof body.model === "string" ? body.model : "";
  const attempts = attemptsFor(requestedModel);
  if (attempts.length === 0) {
    json(res, 400, { error: { message: `Unknown gateway model: ${requestedModel}`, type: "invalid_request_error" } });
    return;
  }

  let lastStatus = 502;
  let lastText = "";
  for (const { target } of attempts) {
    const base = directOpenAIBaseUrl(target);
    if (!base) { lastText = `no route for provider ${target.provider}`; continue; }

    // 1) Native streaming, piped verbatim (keeps tool-call deltas + usage).
    try {
      const upstream = await callProvider(base, path, body, target);
      if (upstream.ok) {
        await pipeStreamingResponse(upstream, res);
        return;
      }
      const text = await upstream.text();
      if (!shouldFallback(upstream.status)) {
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(text);
        return;
      }
      lastStatus = upstream.status;
      lastText = text;
    } catch (err) {
      lastStatus = 502;
      lastText = err instanceof Error ? err.message : String(err);
    }

    // 2) Fallback: non-streaming call re-emitted as a synthetic SSE stream.
    try {
      const upstream = await callProvider(base, path, { ...body, stream: false }, target);
      const text = await upstream.text();
      if (!upstream.ok) {
        if (!shouldFallback(upstream.status)) {
          res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
          res.end(text);
          return;
        }
        lastStatus = upstream.status;
        lastText = text;
        continue;
      }
      writeSyntheticSse(text, res);
      return;
    } catch (err) {
      lastStatus = 502;
      lastText = err instanceof Error ? err.message : String(err);
    }
  }

  json(res, lastStatus, {
    error: {
      message: `All gateway streaming attempts failed for ${requestedModel}: ${lastText.slice(0, 500)}`,
      type: "gateway_error",
    },
  });
}

async function pipeStreamingResponse(upstream: Response, res: ServerResponse): Promise<void> {
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    "cache-control": upstream.headers.get("cache-control") ?? "no-cache",
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function writeSyntheticSse(upstreamText: string, res: ServerResponse): void {
  let completion: any;
  try {
    completion = JSON.parse(upstreamText);
  } catch {
    json(res, 502, { error: { message: `Invalid upstream JSON: ${upstreamText.slice(0, 500)}`, type: "gateway_error" } });
    return;
  }

  const choice = Array.isArray(completion.choices) ? completion.choices[0] : undefined;
  const message = choice?.message ?? {};
  const model = completion.model ?? "unknown";
  const id = completion.id ?? `chatcmpl-${Date.now()}`;
  const created = completion.created ?? Math.floor(Date.now() / 1000);
  const finishReason = choice?.finish_reason ?? (message.tool_calls ? "tool_calls" : "stop");

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: message.role ?? "assistant" }, finish_reason: null }],
  });

  if (typeof message.content === "string" && message.content.length > 0) {
    writeSse(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const [index, toolCall] of message.tool_calls.entries()) {
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: toolCall.id,
              type: toolCall.type ?? "function",
              function: {
                name: toolCall.function?.name,
                arguments: toolCall.function?.arguments ?? "",
              },
            }],
          },
          finish_reason: null,
        }],
      });
    }
  }

  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    ...(completion.usage ? { usage: completion.usage } : {}),
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeSse(res: ServerResponse, body: unknown): void {
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  if (req.method === "GET" && (url === "/" || url === "/health")) {
    json(res, 200, { ok: true, gateway: "llm-gateway" });
    return;
  }
  if (req.method === "GET" && url === "/v1/models") {
    json(res, 200, { object: "list", data: Object.keys(models).map((id) => ({ id, object: "model" })) });
    return;
  }
  if (req.method === "GET" && url === "/rates") {
    json(res, 200, rates);
    return;
  }
  if (req.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/v1/embeddings")) {
    json(res, 404, { error: { message: "not found", type: "gateway_error" } });
    return;
  }

  try {
    const body = JSON.parse(await readBody(req)) as Json;
    const meta = callMeta(req, body);
    const path = url.replace(/^\/v1/, "");
    if (body.stream === true) {
      await proxyStream(path, body, res, meta);
    } else {
      await proxyJson(path, body, res, meta);
    }
  } catch (err) {
    json(res, 500, { error: { message: err instanceof Error ? err.message : String(err), type: "gateway_error" } });
  }
}

export function startGateway(port = PORT): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[llm-gateway] listening on http://127.0.0.1:${port}/v1 (direct OpenAI-compatible routing)`);
  });
  return server;
}

if (process.argv[1]?.endsWith("gateway.ts") || process.argv[1]?.endsWith("gateway.js")) {
  startGateway();
}
