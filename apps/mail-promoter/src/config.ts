export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    llmEndpoint: env.MAIL_PROMOTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions",
    classifyModel: env.MAIL_PROMOTER_CLASSIFY_MODEL ?? "local-chat",
    distillModel: env.MAIL_PROMOTER_DISTILL_MODEL ?? "sub-opus",
    apiKey: env.MAIL_PROMOTER_LLM_API_KEY,
  };
}
