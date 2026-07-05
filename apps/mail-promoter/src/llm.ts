import { usageHeaders } from "@steward/protocol";

export type Chat = (system: string, user: string) => Promise<string>;

/** Build an OpenAI-compatible chat function over the gateway (or any OpenAI endpoint). */
export function gatewayChat(
  cfg: { endpoint: string; model: string; apiKey?: string; usage?: { service: string; action: string } },
  fetchImpl: typeof fetch = fetch,
): Chat {
  return async (system, user) => {
    const res = await fetchImpl(cfg.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        ...(cfg.usage ? usageHeaders(cfg.usage.service, cfg.usage.action) : {}),
      },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`gateway chat ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  };
}
