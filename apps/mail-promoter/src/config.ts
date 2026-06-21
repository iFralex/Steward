export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    llmEndpoint: env.MAIL_PROMOTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions",
    // Conservative defaults pending a labelled eval: classify on a strong free
    // tier, distill on the top subscription tier. Gateway escalates up on failure.
    classifyModel: env.MAIL_PROMOTER_CLASSIFY_MODEL ?? "tier-3",
    distillModel: env.MAIL_PROMOTER_DISTILL_MODEL ?? "tier-6",
    apiKey: env.MAIL_PROMOTER_LLM_API_KEY,
  };
}
