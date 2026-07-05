import type { EmbeddingConfig } from "@steward/embedding";
import { usageHeaders } from "@steward/protocol";

export function loadEmbedConfig(env: NodeJS.ProcessEnv = process.env, service = "mail-mirror"): EmbeddingConfig | null {
  // Default to the unified LLM gateway (sub-project 3). Override with
  // MAIL_EMBED_ENDPOINT/MODEL; set MAIL_EMBED_ENDPOINT=off (or "") to disable.
  const endpoint = env.MAIL_EMBED_ENDPOINT ?? "http://127.0.0.1:4000/v1/embeddings";
  if (!endpoint || endpoint === "off") return null;
  const cfg: EmbeddingConfig = {
    endpoint,
    model: env.MAIL_EMBED_MODEL ?? "local-embed",
    extraHeaders: usageHeaders(service, "embed"),
  };
  if (env.MAIL_EMBED_API_KEY) cfg.apiKey = env.MAIL_EMBED_API_KEY;
  const dim = env.MAIL_EMBED_DIM ? Number(env.MAIL_EMBED_DIM) : NaN;
  if (Number.isFinite(dim) && dim > 0) cfg.outputDimensionality = dim;
  return cfg;
}
