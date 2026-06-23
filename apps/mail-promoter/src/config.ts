export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    llmEndpoint: env.MAIL_PROMOTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions",
    // Classify + distil now run in ONE call (see triage.ts). The combined task is
    // at least as demanding as distillation, which needed tier-5 (sonnet) to stay
    // faithful on rich real emails, so we default to tier-5 and let the gateway
    // escalate up on failure. (The mini-eval confirms a cheap model — e.g. DeepSeek
    // V4 Flash — handles the combined task; the tier label maps to it in the gateway.)
    triageModel: env.MAIL_PROMOTER_TRIAGE_MODEL ?? "tier-5",
    apiKey: env.MAIL_PROMOTER_LLM_API_KEY,
  };
}
