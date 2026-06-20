// apps/llm-gateway/scripts/smoke.mts
// Live smoke of the running gateway. Needs LiteLLM up + Ollama up + OpenRouter keys.
// Run: node --import tsx scripts/smoke.mts
import { extractJson } from "../src/extract-json.ts";

const BASE = process.env.GATEWAY_URL ?? "http://127.0.0.1:4000";
let failed = false;

async function embed(): Promise<void> {
  const res = await fetch(`${BASE}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local-embed", input: "hello world" }),
  });
  const data = (await res.json()) as { data?: { embedding: number[] }[] };
  const dim = data.data?.[0]?.embedding?.length ?? 0;
  if (res.ok && dim > 0) console.log(`[local-embed] OK — ${dim}-dim vector`);
  else { console.error(`[local-embed] FAIL — status ${res.status}`); failed = true; }
}

async function chat(): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "api-default",
      messages: [{ role: "user", content: 'Reply with ONLY this JSON: {"ok": true}' }],
    }),
  });
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content ?? "";
  try {
    const parsed = extractJson(text) as { ok?: boolean };
    if (res.ok && parsed.ok === true) console.log("[api-default] OK — JSON round-trip via OpenRouter");
    else { console.error(`[api-default] FAIL — status ${res.status}, body: ${text.slice(0, 120)}`); failed = true; }
  } catch (e) {
    console.error(`[api-default] FAIL — could not extract JSON: ${(e as Error).message}; body: ${text.slice(0, 120)}`);
    failed = true;
  }
}

await embed();
await chat();
process.exit(failed ? 1 : 0);
