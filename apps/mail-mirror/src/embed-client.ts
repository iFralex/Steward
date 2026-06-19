import { fetchEmbedding, fetchEmbeddingBatch, type EmbeddingConfig } from "@llm-wiki/embedding";

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

/** Embed multiple texts in a single batch request. Returns per-text vectors (null on failure). */
export async function embedTexts(
  texts: string[],
  cfg: EmbeddingConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<(number[] | null)[]> {
  const r = await fetchEmbeddingBatch(texts, cfg, {
    fetch: fetchImpl,
    isNetworkError: (e) => e instanceof TypeError,
  });
  return r.vectors;
}
