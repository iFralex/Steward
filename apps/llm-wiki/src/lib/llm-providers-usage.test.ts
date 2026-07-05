import { describe, expect, it } from "vitest"
import { stewardGatewayUsageHeaders, getProviderConfig } from "./llm-providers"

describe("stewardGatewayUsageHeaders", () => {
  it("returns llm-wiki/chat headers for the local gateway only", () => {
    expect(stewardGatewayUsageHeaders("http://127.0.0.1:4000/v1/chat/completions")).toEqual({
      "x-usage-service": "llm-wiki",
      "x-usage-action": "chat",
    })
    expect(stewardGatewayUsageHeaders("https://api.openai.com/v1/chat/completions")).toEqual({})
    expect(stewardGatewayUsageHeaders("not a url")).toEqual({})
  })

  it("is wired into the custom provider config for gateway endpoints", () => {
    const cfg = getProviderConfig({
      provider: "custom",
      customEndpoint: "http://127.0.0.1:4000/v1",
      apiKey: "",
      model: "tier-5",
      ollamaUrl: "",
    } as never)
    expect(cfg.headers["x-usage-service"]).toBe("llm-wiki")
  })
})
