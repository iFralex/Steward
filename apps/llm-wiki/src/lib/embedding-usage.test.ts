/**
 * withUsageAttribution: the gateway meters embedding calls by attribution
 * headers. This must apply ONLY to the local steward gateway — never to
 * third-party embedding APIs (OpenAI, Google, etc).
 */
import { describe, expect, it } from "vitest"
import { withUsageAttribution } from "./embedding"
import type { EmbeddingConfig } from "@/stores/wiki-store"

describe("withUsageAttribution", () => {
  it("labels gateway endpoints as llm-wiki/embed", () => {
    const cfg = withUsageAttribution({
      endpoint: "http://127.0.0.1:4000/v1/embeddings",
      model: "local-embed",
    } as EmbeddingConfig)
    expect(cfg.extraHeaders?.["x-usage-service"]).toBe("llm-wiki")
    expect(cfg.extraHeaders?.["x-usage-action"]).toBe("embed")
  })

  it("never labels third-party endpoints", () => {
    const cfg = withUsageAttribution({
      endpoint: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
    } as EmbeddingConfig)
    expect(cfg.extraHeaders?.["x-usage-service"]).toBeUndefined()
  })
})
