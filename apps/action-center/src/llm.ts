import { extractJson } from "../../llm-gateway/src/extract-json.ts";

export type Chat = (system: string, user: string) => Promise<string>;

export function gatewayChat(
  cfg: { endpoint?: string; model?: string; apiKey?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Chat {
  const endpoint = cfg.endpoint ?? process.env.ACTION_CENTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions";
  const model = cfg.model ?? process.env.ACTION_CENTER_LLM_MODEL ?? "tier-5";
  const apiKey = cfg.apiKey ?? process.env.ACTION_CENTER_LLM_API_KEY;
  return async (system, user) => {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`action-center gateway chat ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  };
}

export function jsonFromLlm<T extends object>(text: string): T | null {
  try {
    const parsed = extractJson(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}
