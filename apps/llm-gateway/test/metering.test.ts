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

// One shared temp ledger dir for the whole file (the ledger singleton caches it).
process.env.USAGE_DIR = mkdtempSync(join(tmpdir(), "gw-metering-"));

test("gateway metering: non-streaming chat, embeddings, unknown fallback, failures", async (t) => {
  const provider = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { model: string; input?: unknown };
    if (req.url?.endsWith("/embeddings")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }], model: body.model, usage: { prompt_tokens: 7, total_tokens: 7 } }));
      return;
    }
    if (typeof body.model === "string" && body.model.includes("pro")) {
      // used to simulate a deterministic 400 (no fallback)
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "cmpl-1", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 },
    }));
  });
  const providerPort = await listen(provider);
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  process.env.DEEPSEEK_API_KEY = "sk-test";
  // Route the local tiers at the same mock (tier-1/local-embed use customHost).
  const { startGateway, models } = await import("../src/gateway.ts");
  models["local-embed"].customHost = `http://127.0.0.1:${providerPort}`;
  const gw = startGateway(0);
  await new Promise((resolve) => gw.on("listening", resolve));
  const gwPort = (gw.address() as { port: number }).port;
  const { usageLedger } = await import("@steward/usage-ledger");
  t.after(() => { gw.close(); provider.close(); });

  // 1) labeled chat call → row with attribution + token split + cost
  const r1 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-usage-service": "mail-promoter",
      "x-usage-action": "triage",
      "x-usage-session": "run-1",
    },
    body: JSON.stringify({ model: "tier-5", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r1.status, 200);

  // 2) unlabeled call → unknown/unknown
  await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-5", messages: [{ role: "user", content: "hi" }] }),
  });

  // 3) embeddings call → volume row, cost 0 (no rates for local-embed)
  await fetch(`http://127.0.0.1:${gwPort}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "mail-mcp", "x-usage-action": "embed" },
    body: JSON.stringify({ model: "local-embed", input: "hello" }),
  });

  // 4) deterministic 4xx → failed row, tokens 0 (tier-6 = pro model → mock 400s)
  const r4 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "action-center", "x-usage-action": "scan" },
    body: JSON.stringify({ model: "tier-6", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r4.status, 400);

  const rows = usageLedger().raw.prepare(`SELECT * FROM llm_calls ORDER BY id`).all() as any[];
  assert.equal(rows.length, 4);

  assert.equal(rows[0].service, "mail-promoter");
  assert.equal(rows[0].action, "triage");
  assert.equal(rows[0].session_id, "run-1");
  assert.equal(rows[0].tier, "tier-5");
  assert.equal(rows[0].input_tokens, 60);      // prompt 100 - cacheRead 40
  assert.equal(rows[0].cache_read_tokens, 40);
  assert.equal(rows[0].output_tokens, 20);
  assert.equal(rows[0].ok, 1);
  // tier-5: (60*0.14 + 20*0.28 + 40*0.0028) / 1e6
  assert.ok(Math.abs(rows[0].cost_usd - 0.000014112) < 1e-12);

  assert.equal(rows[1].service, "unknown");
  assert.equal(rows[1].action, "unknown");

  assert.equal(rows[2].service, "mail-mcp");
  assert.equal(rows[2].input_tokens, 7);
  assert.equal(rows[2].cost_usd, 0);

  assert.equal(rows[3].service, "action-center");
  assert.equal(rows[3].ok, 0);
  assert.equal(rows[3].status, 400);
  assert.equal(rows[3].input_tokens, 0);
});
