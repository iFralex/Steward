export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    llmEndpoint: env.MAIL_PROMOTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions",
    // Measured tiers (lowest that does the job reliably):
    // classify: tier-4 (haiku) agrees 15/15 with the tier-6 oracle, 0 errors
    //   (free tiers 1-3 unreliable: rate-limits + mismatches).
    // distill: tier-5 (sonnet) is faithful on rich real emails (no hallucination,
    //   correct commitment attribution) ~ matching tier-6, while tier-4 slips
    //   (misframes marketing, invents a year, mislabels a phone as a commitment).
    // Gateway escalates up on failure.
    classifyModel: env.MAIL_PROMOTER_CLASSIFY_MODEL ?? "tier-4",
    distillModel: env.MAIL_PROMOTER_DISTILL_MODEL ?? "tier-5",
    apiKey: env.MAIL_PROMOTER_LLM_API_KEY,
  };
}
