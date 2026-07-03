import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

test("non-streaming routes direct to the provider, forwards tools, and falls back across tiers", async () => {
  const seen: {
    model: string;
    hasTools: boolean;
    auth: string | undefined;
    roles: unknown[];
    thinking: unknown;
    hasStore: boolean;
    hasReasoningEffort: boolean;
  }[] = [];
  let calls = 0;

  // Stand-in for the provider's OpenAI-compatible endpoint (DEEPSEEK_BASE_URL).
  const provider = createServer(async (req, res) => {
    calls++;
    const body = JSON.parse(await readBody(req)) as {
      model: string;
      messages?: { role?: unknown }[];
      tools?: unknown[];
      thinking?: unknown;
      store?: unknown;
      reasoning_effort?: unknown;
    };
    seen.push({
      model: body.model,
      hasTools: Array.isArray(body.tools),
      auth: req.headers["authorization"] as string | undefined,
      roles: body.messages?.map((message) => message.role) ?? [],
      thinking: body.thinking,
      hasStore: Object.hasOwn(body, "store"),
      hasReasoningEffort: Object.hasOwn(body, "reasoning_effort"),
    });
    if (calls === 1) { // first tier fails → sweep to the next
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "try next" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_time", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as { port: number }).port;

  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  process.env.DEEPSEEK_API_KEY = "sk-test";
  const { startGateway } = await import("../src/gateway.ts");
  const compat = startGateway(0);
  await new Promise<void>((resolve) => compat.once("listening", resolve));
  const compatPort = (compat.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${compatPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "tier-5",
        messages: [{ role: "developer", content: "use tools" }, { role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "get_time", parameters: { type: "object", properties: {} } } }],
        tool_choice: "auto",
        store: false,
        reasoning_effort: "medium",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "get_time");
    // Went direct to the provider, swept flash → pro, and forwarded tools.
    assert.deepEqual(seen.map((s) => s.model), ["deepseek-v4-flash", "deepseek-v4-pro"]);
    assert.ok(seen[0].hasTools, "tools forwarded to the provider");
    assert.deepEqual(seen[0].roles, ["system", "user"]);
    assert.deepEqual(seen[0].thinking, { type: "disabled" });
    assert.equal(seen[0].hasStore, false);
    assert.equal(seen[0].hasReasoningEffort, false);
    assert.equal(seen[1].auth, "Bearer sk-test");
  } finally {
    await new Promise<void>((resolve) => compat.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test("GET /rates returns per-tier USD costs per 1M tokens", async () => {
  // Dynamic import for the same env-ordering reason as the test below.
  const { startGateway } = await import("../src/gateway.ts");
  const server = startGateway(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rates`);
    const body = await res.json() as Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
    assert.equal(body["tier-1"].input, 0);
    assert.equal(body["tier-5"].input, 0.14);
    assert.equal(body["tier-6"].output, 0.87);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("shouldFallback: retry 429/5xx, surface 4xx immediately", async () => {
  // Dynamic import (not a top-level static import): a static import would evaluate
  // gateway.ts's module-level code eagerly, before the test above sets
  // DEEPSEEK_API_KEY, and since ESM modules are singletons the later dynamic
  // import in that test would just return the already-poisoned cached module.
  const { shouldFallback } = await import("../src/gateway.ts");
  assert.equal(shouldFallback(429), true);
  assert.equal(shouldFallback(500), true);
  assert.equal(shouldFallback(503), true);
  assert.equal(shouldFallback(400), false);
  assert.equal(shouldFallback(401), false);
  assert.equal(shouldFallback(404), false);
});
