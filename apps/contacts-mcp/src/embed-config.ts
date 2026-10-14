import type { EmbeddingConfig } from "@steward/embedding";
import { gatewayCredential, usageHeaders } from "@steward/protocol";

export function loadEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  const endpoint = env.MAIL_EMBED_ENDPOINT ?? "http://127.0.0.1:4000/v1/embeddings";
  if (!endpoint || endpoint === "off") return null;
  const cfg: EmbeddingConfig = {
    endpoint,
    model: env.MAIL_EMBED_MODEL ?? "local-embed",
    extraHeaders: usageHeaders("contacts-mcp", "embed"),
  };
  const apiKey = gatewayCredential(endpoint, env.MAIL_EMBED_API_KEY, env.GATEWAY_API_KEY, Number(env.GATEWAY_PORT ?? 4000));
  if (apiKey) cfg.apiKey = apiKey;
  const dim = env.MAIL_EMBED_DIM ? Number(env.MAIL_EMBED_DIM) : NaN;
  if (Number.isFinite(dim) && dim > 0) cfg.outputDimensionality = dim;
  return cfg;
}
