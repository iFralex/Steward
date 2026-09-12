import { embedText } from "@steward/search";
import { usageHeaders } from "@steward/protocol";

export function flowEmbeddingText(flow: { name: string; when: string }): string {
  return `${flow.name}\nWhen this flow applies: ${flow.when}`;
}

export async function embedFlowText(text: string): Promise<number[] | null> {
  const endpoint = process.env.ACTION_FLOW_EMBED_ENDPOINT ?? process.env.MAIL_EMBED_ENDPOINT ?? "http://127.0.0.1:4000/v1/embeddings";
  if (!endpoint || endpoint === "off") return null;
  return embedText(text, {
    endpoint,
    model: process.env.ACTION_FLOW_EMBED_MODEL ?? process.env.MAIL_EMBED_MODEL ?? "local-embed",
    apiKey: process.env.ACTION_FLOW_EMBED_API_KEY ?? process.env.MAIL_EMBED_API_KEY,
    extraHeaders: usageHeaders("action-center", "flow-retrieval"),
  });
}

export function flowQuery(input: { fromName: string; fromAddr: string; subject: string; bodyText: string }, analyzed: { kind?: unknown; summary?: unknown }): string {
  return [input.fromName, input.fromAddr, input.subject, analyzed.kind, analyzed.summary, input.bodyText.slice(0, 1800)].filter(Boolean).join("\n");
}
