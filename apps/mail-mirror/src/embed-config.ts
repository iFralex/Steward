import type { EmbeddingConfig } from "@llm-wiki/embedding";

export function loadEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  const endpoint = env.MAIL_EMBED_ENDPOINT;
  if (!endpoint) return null;
  const cfg: EmbeddingConfig = { endpoint, model: env.MAIL_EMBED_MODEL ?? "" };
  if (env.MAIL_EMBED_API_KEY) cfg.apiKey = env.MAIL_EMBED_API_KEY;
  const dim = env.MAIL_EMBED_DIM ? Number(env.MAIL_EMBED_DIM) : NaN;
  if (Number.isFinite(dim) && dim > 0) cfg.outputDimensionality = dim;
  return cfg;
}
