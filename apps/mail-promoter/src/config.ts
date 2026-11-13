export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    llmEndpoint: env.MAIL_PROMOTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions",
    // Classify + distil now run in ONE call (see triage.ts). The combined task is
    // at least as demanding as distillation, which needed tier-5 (sonnet) to stay
    // faithful on rich real emails, so we default to tier-5 and let the gateway
    // escalate up on failure. (The mini-eval confirms a cheap model — e.g. DeepSeek
    // V4 Flash — handles the combined task; the tier label maps to it in the gateway.)
    triageModel: env.MAIL_PROMOTER_TRIAGE_MODEL ?? "tier-5",
    apiKey: env.MAIL_PROMOTER_LLM_API_KEY,
    gteMode: env.MAIL_PROMOTER_GTE_MODE ?? "off",
    gteManifest: env.MAIL_PROMOTER_GTE_MANIFEST,
    gteWorker: env.MAIL_PROMOTER_GTE_WORKER,
    gtePython: env.MAIL_PROMOTER_GTE_PYTHON,
    maxGateScores: positive("MAIL_PROMOTER_MAX_GTE_SCORES", 500),
    maxGatewayCalls: positive("MAIL_PROMOTER_MAX_GATEWAY_CALLS", 100),
  };
}
