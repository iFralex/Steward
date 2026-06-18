import { fetchEmbedding, type EmbeddingConfig } from "@llm-wiki/embedding";

/** Embed text via the shared package using Node fetch. Returns null on any failure. */
export async function embedText(
  text: string,
  cfg: EmbeddingConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number[] | null> {
  const result = await fetchEmbedding(text, cfg, {
    fetch: fetchImpl,
    isNetworkError: (e) => e instanceof TypeError,
  });
  return result.vector;
}
