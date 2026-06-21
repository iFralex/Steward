export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    llmEndpoint: env.MAIL_PROMOTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions",
    // classify: tier-4 (haiku) agrees 15/15 with the tier-6 oracle, 0 errors;
    // the free tiers (1-3) are unreliable (rate-limits + mismatches). distill
    // writes the durable wiki note -> top tier. Gateway escalates up on failure.
    classifyModel: env.MAIL_PROMOTER_CLASSIFY_MODEL ?? "tier-4",
    distillModel: env.MAIL_PROMOTER_DISTILL_MODEL ?? "tier-6",
    apiKey: env.MAIL_PROMOTER_LLM_API_KEY,
  };
}
