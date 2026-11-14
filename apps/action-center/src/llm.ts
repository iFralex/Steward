import { extractJson } from "../../llm-gateway/src/extract-json.ts";
import { gatewayCredential, usageHeaders } from "@steward/protocol";

export type Chat = (system: string, user: string) => Promise<string>;
export class GatewayChatError extends Error {
  constructor(readonly status: number, options?: ErrorOptions) {
    super(`action-center gateway chat ${status}`, options);
  }
}

export function gatewayChat(
  cfg: { endpoint?: string; model?: string; apiKey?: string; usageAction?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Chat {
  const endpoint = cfg.endpoint ?? process.env.ACTION_CENTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions";
  const model = cfg.model ?? process.env.ACTION_CENTER_LLM_MODEL ?? "tier-5";
  const apiKey = gatewayCredential(endpoint, cfg.apiKey ?? process.env.ACTION_CENTER_LLM_API_KEY, process.env.GATEWAY_API_KEY, Number(process.env.GATEWAY_PORT ?? 4000));
  return async (system, user) => {
    let res: Response;
    try { res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...usageHeaders("action-center", cfg.usageAction ?? "scan"),
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    }); } catch (cause) { throw new GatewayChatError(0, { cause }); }
    if (!res.ok) throw new GatewayChatError(res.status);
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
