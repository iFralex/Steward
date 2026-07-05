import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as { port: number }).port);
  }));
}

process.env.USAGE_DIR = mkdtempSync(join(tmpdir(), "gw-e2e-"));

test("e2e: labeled gateway call is exposed by the ledger summary the /usage page reads", async (t) => {
  const provider = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "cmpl-1", model: "deepseek-v4-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
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

  const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "e2e-svc", "x-usage-action": "e2e-act" },
    body: JSON.stringify({ model: "tier-5", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);

  const s = usageLedger().summary(7);
  const svc = s.byService.find((x) => x.service === "e2e-svc");
  assert.ok(svc, "byService exposes the labeled service");
  assert.equal(svc.calls, 1);
  assert.ok(svc.cost > 0);
  const act = s.byAction.find((x) => x.service === "e2e-svc" && x.action === "e2e-act");
  assert.ok(act, "byAction exposes the labeled action");
  assert.ok(Math.abs(act.avgCost - act.cost) < 1e-12);
  assert.equal(s.recent[0].service, "e2e-svc");
  assert.equal(s.byDay.some((d) => d.service === "e2e-svc"), true);

  // Spec: metering must never break an LLM call. Kill the ledger DB and
  // verify the gateway still answers 200 (recordCall catches and warns).
  usageLedger().raw.close();
  const res2 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "e2e-svc", "x-usage-action": "e2e-act" },
    body: JSON.stringify({ model: "tier-5", messages: [{ role: "user", content: "hi again" }] }),
  });
  assert.equal(res2.status, 200);
});
