import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { captureRequestOrigin } from "../src/request-origin.js";
import { recordRequestOrigin } from "../src/request-origin.js";
import Database from "better-sqlite3";

test("origin captures shape while excluding payloads, credentials and URL query strings", async () => {
  const req = { method: "POST", url: "/v1/embeddings?key=secret-query",
    socket: { remoteAddress: "127.0.0.1", remotePort: 12345, localPort: 4000 },
    headers: { authorization: "Bearer super-secret", cookie: "session=secret",
      "user-agent": "origin-test", origin: "https://name:password@example.com/path?token=secret",
      referer: "https://example.org/private?key=secret" } } as unknown as IncomingMessage;
  const result = await captureRequestOrigin(req, { input: ["sensitive text", "private mail"],
    messages: [{ role: "user", content: "private message" }], tools: [{ function: { name: "private" } }] });
  assert.equal(result.path, "/v1/embeddings");
  assert.equal(result.origin, "https://example.com");
  assert.equal(result.refererOrigin, "https://example.org");
  assert.equal(result.shape.inputItems, 2);
  assert.equal(result.shape.inputChars, 26);
  for (const secret of ["super-secret", "secret-query", "password", "sensitive text", "private mail", "private message", "cookie"])
    assert.ok(!JSON.stringify(result).includes(secret));
});

test("macOS peer probe resolves the actual TCP client without command-line arguments", {
  skip: process.platform !== "darwin" || !process.env.STEWARD_GATEWAY_PEER_BIN,
}, async () => {
  let captured: Promise<Awaited<ReturnType<typeof captureRequestOrigin>>>;
  const server = createServer((req,res) => {
    captured = captureRequestOrigin(req, { input: "test" });
    void captured.then(() => { res.end("ok"); });
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  try {
    await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/embeddings`);
    const result = await captured!;
    assert.equal(result.process.status, "matched");
    const chain = result.process.chain as Array<{ pid: number; executable: string }>;
    assert.equal(chain[0].pid, process.pid);
    assert.ok(chain[0].executable.endsWith("node"));
    assert.ok(!JSON.stringify(chain).includes("test/request-origin"));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("origin retention bounds diagnostics without deleting any billing history", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY,cost_usd REAL); INSERT INTO llm_calls VALUES (1,3.5)");
  const origin = await captureRequestOrigin({ method: "POST", url: "/v1/embeddings",
    headers: {}, socket: { remoteAddress: "192.0.2.1", remotePort: 12345 } } as unknown as IncomingMessage, {});
  try {
    db.transaction(() => {
      for (let i = 0; i < 10128; i++) recordRequestOrigin(db, `r${i}`, 1, i, origin);
    })();
    const count = (db.prepare("SELECT COUNT(*) n FROM request_origins").get() as { n: number }).n;
    assert.ok(count >= 10000 && count <= 10127);
    assert.equal((db.prepare("SELECT SUM(cost_usd) cost FROM llm_calls").get() as { cost: number }).cost, 3.5);
    assert.ok(db.prepare("SELECT 1 FROM request_origins WHERE request_id='r10127'").get());
  } finally { db.close(); }
});
