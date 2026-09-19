import { usageHeaders } from "@steward/protocol";
import type { GatewayConfig } from "./pi-provider.ts";

export type WatchNotificationComposer = (prompt: string) => Promise<string>;

/**
 * Build a deliberately stateless LLM caller for automatic notifications.
 * Unlike ChatManager, it has no Pi session, transcript memory, or tools, so it
 * cannot contend with or mutate the user's persistent chat session.
 */
export function createWatchNotificationComposer(
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
): WatchNotificationComposer {
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  return async (prompt) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        ...usageHeaders("host", "watch-notification"),
      },
      body: JSON.stringify({
        model: config.tier,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(Math.max(1_000, Number(process.env.WATCH_NOTIFICATION_TIMEOUT_MS ?? 30_000))),
    });
    if (!response.ok) throw new Error(`watch notification gateway ${response.status}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = typeof data.choices?.[0]?.message?.content === "string"
      ? data.choices[0].message.content.trim()
      : "";
    if (!text) throw new Error("The notification composer produced no reply");
    return text;
  };
}
