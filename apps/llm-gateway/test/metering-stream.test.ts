import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => { data += c.toString("utf8"); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as { port: number }).port);
  }));
}
function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

process.env.USAGE_DIR = mkdtempSync(join(tmpdir(), "gw-stream-metering-"));

test("streaming chat records usage from the final SSE chunk; absent usage records tokens 0", async (t) => {
  let sendUsage = true;
  const requests: { stream_options?: unknown }[] = [];
  const provider = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { model: string; stream_options?: unknown };
    requests.push({ stream_options: body.stream_options });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks: unknown[] = [
      { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
      {
        id: "c1", object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        ...(sendUsage ? { usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 30 } } : {}),
      },
    ];
    res.end(sse(chunks));
  });
  const providerPort = await listen(provider);
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  process.env.DEEPSEEK_API_KEY = "sk-test";
  const { startGateway } = await import("../src/gateway.ts");
  const gw = startGateway(0);
  await new Promise((resolve) => gw.on("listening", resolve));
  const gwPort = (gw.address() as { port: number }).port;
  const { usageLedger } = await import("@steward/usage-ledger");
  t.after(() => { gw.close(); provider.close(); });

  const call = () => fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "host", "x-usage-action": "agent-turn" },
    body: JSON.stringify({ model: "tier-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

  const r1 = await call();
  await r1.text(); // drain the SSE stream
  sendUsage = false;
  const r2 = await call();
  await r2.text();

  // include_usage was injected toward DeepSeek
  assert.deepEqual(requests[0].stream_options, { include_usage: true });

  const rows = usageLedger().raw.prepare(`SELECT * FROM llm_calls ORDER BY id`).all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].service, "host");
  assert.equal(rows[0].input_tokens, 20);   // 50 - 30 cached
  assert.equal(rows[0].cache_read_tokens, 30);
  assert.equal(rows[0].output_tokens, 10);
  assert.equal(rows[0].ok, 1);
  // no usage chunk → tokens 0, call still counted
  assert.equal(rows[1].input_tokens, 0);
  assert.equal(rows[1].output_tokens, 0);
  assert.equal(rows[1].ok, 1);
});

test("synthetic-fallback with unparseable upstream body records a failure matching the client's 502", async (t) => {
  const provider = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { stream?: boolean };
    if (body.stream === true) {
      // Fail the native streaming attempt so the gateway falls back.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stream broke" } }));
      return;
    }
    // Non-streaming fallback: HTTP 200 but a body writeSyntheticSse cannot parse.
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not json");
  });
  const providerPort = await listen(provider);
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  process.env.DEEPSEEK_API_KEY = "sk-test";
  const { startGateway } = await import("../src/gateway.ts");
  const gw = startGateway(0);
  await new Promise((resolve) => gw.on("listening", resolve));
  const gwPort = (gw.address() as { port: number }).port;
  const { usageLedger } = await import("@steward/usage-ledger");
  t.after(() => { gw.close(); provider.close(); });

  const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "host", "x-usage-action": "synthetic-fail" },
    body: JSON.stringify({ model: "tier-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  await r.text();
  assert.equal(r.status, 502);

  const rows = usageLedger().raw
    .prepare(`SELECT * FROM llm_calls WHERE action = 'synthetic-fail' ORDER BY id`)
    .all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, 0);
  assert.equal(rows[0].status, 502);
});
