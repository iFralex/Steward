import assert from "node:assert/strict";
import { test } from "node:test";
import { createWatchNotificationComposer } from "../src/core/watch-notification-composer.ts";

const config = {
  baseUrl: "http://gateway.test/v1/",
  tier: "tier-1",
  apiKey: "sk-test",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("watch composer uses a stateless, metered completion with no tools or session state", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const compose = createWatchNotificationComposer(config, async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ choices: [{ message: { content: "  Binario 4 confermato.  " } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });

  assert.equal(await compose("structured event"), "Binario 4 confermato.");
  assert.equal(request?.url, "http://gateway.test/v1/chat/completions");
  const headers = request?.init?.headers as Record<string, string>;
  assert.equal(headers["x-usage-service"], "host");
  assert.equal(headers["x-usage-action"], "watch-notification");
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body.messages, [{ role: "user", content: "structured event" }]);
  assert.equal(body.tools, undefined);
});

test("watch composer rejects unsuccessful and empty gateway replies", async () => {
  const failed = createWatchNotificationComposer(config, async () => new Response("no", { status: 503 }));
  await assert.rejects(failed("event"), /gateway 503/);

  const empty = createWatchNotificationComposer(config, async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
  await assert.rejects(empty("event"), /produced no reply/);
});
