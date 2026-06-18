import type { EmbeddingConfig, EmbeddingDeps, EmbeddingResult } from "./types.ts";
import {
  isGoogleEmbeddingConfig,
  isDoubaoMultimodalEmbeddingConfig,
  googleEmbeddingEndpoint,
  volcengineEmbeddingEndpoint,
  isLocalOrPrivateHttpEndpoint,
  isSafeExtraHeader,
  googleEmbeddingBody,
  doubaoMultimodalEmbeddingBody,
  isNonEmptyNumberArray,
  looksLikeOversizeError,
} from "./providers.ts";

export async function fetchEmbedding(
  text: string,
  cfg: EmbeddingConfig,
  deps: EmbeddingDeps,
  maxRetries = 3,
): Promise<EmbeddingResult> {
  if (!cfg.endpoint) return { vector: null }

  const isGoogleNative = isGoogleEmbeddingConfig(cfg)
  const isDoubaoMultimodal = isDoubaoMultimodalEmbeddingConfig(cfg)
  const endpoint = isGoogleNative
    ? googleEmbeddingEndpoint(cfg)
    : volcengineEmbeddingEndpoint(cfg)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(deps.originHeader && isLocalOrPrivateHttpEndpoint(endpoint) ? deps.originHeader() : {}),
  }
  if (cfg.apiKey) {
    if (isGoogleNative) {
      headers["x-goog-api-key"] = cfg.apiKey
    } else {
      headers.Authorization = `Bearer ${cfg.apiKey}`
    }
  }
  if (cfg.extraHeaders) {
    for (const [k, v] of Object.entries(cfg.extraHeaders)) {
      const name = k.trim()
      const value = v.trim()
      if (!isSafeExtraHeader(name, value)) continue
      headers[name] = value
    }
  }

  const httpFetch = deps.fetch
  let current = text
  let attempts = 0
  while (attempts <= maxRetries) {
    attempts++
    try {
      const resp = await httpFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(
          isGoogleNative
            ? googleEmbeddingBody(cfg.model, current, cfg.outputDimensionality)
            : isDoubaoMultimodal
              ? doubaoMultimodalEmbeddingBody(cfg.model, current)
              : { model: cfg.model, input: current },
        ),
      })

      if (resp.ok) {
        const data = await resp.json()
        const embedding = isGoogleNative
          ? (data as any)?.embedding?.values ?? null
          : isDoubaoMultimodal
            ? (data as any)?.data?.embedding ?? null
            : (data as any)?.data?.[0]?.embedding ?? null
        if (isNonEmptyNumberArray(embedding)) {
          return { vector: embedding }
        }
        const expectedShape = isGoogleNative
          ? "embedding.values"
          : isDoubaoMultimodal
            ? "data.embedding"
            : "data[0].embedding"
        const error = `Embedding response missing ${expectedShape} (got ${JSON.stringify(data).slice(0, 200)})`
        return { vector: null, error }
      }

      // Non-OK: try to read the body for an oversize hint.
      let bodyText = ""
      try {
        bodyText = await resp.text()
      } catch {
        // ignore — some servers return empty bodies on error
      }

      if (looksLikeOversizeError(resp.status, bodyText)) {
        // Can we still halve-and-retry? Need room on both axes:
        // text not yet at the 64-char floor, and retry budget left.
        if (current.length > 64 && attempts <= maxRetries) {
          const prev = current.length
          current = current.slice(0, Math.floor(current.length / 2))
          deps.onRetry?.(`auto-halving after HTTP ${resp.status} at ${prev} chars → retrying at ${current.length} chars (attempt ${attempts}/${maxRetries + 1})`);
          continue
        }
        // Out of retries on a SERVER-oversize error — give the user a
        // message that names the smallest size that still failed so
        // they can tune Settings → Embedding accordingly.
        const error = `Endpoint rejected input even at ${current.length} chars — server context smaller than expected. Lower Settings → Embedding → Max Chunk Chars (${bodyText.slice(0, 160)}).`
        return { vector: null, error }
      }

      // Non-oversize definitive failure (auth, rate limit, server down, …).
      const error = `API ${resp.status} ${resp.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ""} at ${endpoint}`
      return { vector: null, error }
    } catch (err) {
      let error: string
      if (deps.isNetworkError?.(err)) {
        error = `Network error reaching ${endpoint}. Check endpoint URL, API key, and connectivity.`
      } else {
        error = err instanceof Error ? err.message : String(err)
      }
      return { vector: null, error }
    }
  }

  // Exhausted retries (only reachable if every halving round triggered
  // the retry branch and then the loop condition ended).
  const error = `Embedding endpoint rejected every size down to ${current.length} chars — the server's context is smaller than ${current.length * 2}. Lower Settings → Embedding → Max Chunk Chars.`
  return { vector: null, error }
}
