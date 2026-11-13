import type { IncomingMessage } from "node:http";
import { execFile } from "node:child_process";
import type Database from "better-sqlite3";

type Json = Record<string, unknown>;
export interface RequestOrigin {
  method: string; path: string; clientAddress: string; clientPort: number;
  userAgent: string | null; origin: string | null; refererOrigin: string | null;
  shape: Json; process: Json;
}
let activeProbes = 0;
function urlOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.origin : null; }
  catch { return null; }
}

/** Metadata only: never retain input text, prompts, credentials or raw headers. */
export async function captureRequestOrigin(req: IncomingMessage, body: Json): Promise<RequestOrigin> {
  const port = req.socket.remotePort ?? 0;
  const address = req.socket.remoteAddress ?? "";
  const input = body.input;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const roleCounts: Record<string, number> = {};
  for (const message of messages) {
    const role = message && typeof message === "object" ? (message as Json).role : null;
    const key = typeof role === "string" && ["system", "developer", "user", "assistant", "tool"].includes(role) ? role : "other";
    roleCounts[key] = (roleCounts[key] ?? 0) + 1;
  }
  const result: RequestOrigin = {
    method: req.method ?? "", path: (req.url ?? "").split("?")[0].slice(0, 120),
    clientAddress: address, clientPort: port,
    userAgent: typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 200) : null,
    origin: urlOrigin(req.headers.origin), refererOrigin: urlOrigin(req.headers.referer),
    shape: { stream: body.stream === true, messages: messages.length, roleCounts,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      inputItems: typeof input === "string" ? 1 : Array.isArray(input) ? input.length : 0,
      inputChars: typeof input === "string" ? input.length : Array.isArray(input)
        ? input.reduce((n: number, item) => n + (typeof item === "string" ? item.length : 0), 0) : 0 },
    process: { status: "unavailable" },
  };
  const helper = process.env.STEWARD_GATEWAY_PEER_BIN;
  if (!helper || process.platform !== "darwin") return result;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
    result.process = { status: "not-loopback" }; return result;
  }
  if (activeProbes >= 2) { result.process = { status: "busy" }; return result; }
  activeProbes++;
  try {
    result.process = await new Promise<Json>(resolve => {
      execFile(helper, [String(port), String(req.socket.localPort ?? 0)], { timeout: 1000, maxBuffer: 8192 }, (error, stdout) => {
        if (error) { resolve({ status: "unavailable" }); return; }
        try { resolve(JSON.parse(stdout) as Json); } catch { resolve({ status: "invalid-probe" }); }
      });
    });
  } finally { activeProbes--; }
  return result;
}

const initialized = new WeakSet<Database.Database>();
let writes = 0;
export function recordRequestOrigin(db: Database.Database, requestId: string, callId: number, ts: number, origin: RequestOrigin): void {
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS request_origins (
      request_id TEXT PRIMARY KEY, llm_call_id INTEGER NOT NULL,
      ts INTEGER NOT NULL, metadata_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_request_origins_ts ON request_origins(ts);`);
    initialized.add(db);
  }
  db.prepare("INSERT OR REPLACE INTO request_origins(request_id,llm_call_id,ts,metadata_json) VALUES (?,?,?,?)")
    .run(requestId, callId, ts, JSON.stringify(origin));
  // Bound diagnostic growth independently of the billing history.
  if (++writes % 128 === 0) db.exec(`DELETE FROM request_origins WHERE rowid IN
    (SELECT rowid FROM request_origins ORDER BY rowid DESC LIMIT -1 OFFSET 10000)`);
}
