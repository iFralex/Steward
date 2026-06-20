// apps/llm-gateway/test/adapter-server.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoApiKey, createAdapterServer } from "../src/adapter.ts";
import type { AddressInfo } from "node:net";

async function* fake(): AsyncIterable<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "pong" }] } };
}

test("assertNoApiKey throws when ANTHROPIC_API_KEY is set", () => {
  assert.throws(() => assertNoApiKey({ ANTHROPIC_API_KEY: "sk-x" } as NodeJS.ProcessEnv), /ANTHROPIC_API_KEY/);
  assert.doesNotThrow(() => assertNoApiKey({} as NodeJS.ProcessEnv));
});

test("server answers /v1/chat/completions with an OpenAI completion", async () => {
  const server = createAdapterServer({ runQuery: () => fake() });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-sub", messages: [{ role: "user", content: "ping" }] }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200);
  assert.equal(body.choices[0].message.content, "pong");
  await new Promise<void>((r) => server.close(() => r()));
});

test("server lists models at /v1/models", async () => {
  const server = createAdapterServer({ runQuery: () => fake() });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  const body = (await res.json()) as any;
  assert.equal(body.object, "list");
  assert.ok(body.data.some((m: { id: string }) => m.id === "claude-opus-sub"));
  await new Promise<void>((r) => server.close(() => r()));
});
