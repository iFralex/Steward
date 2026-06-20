/**
 * Lenient JSON extraction for free-model output. Free `api-*` models often wrap
 * JSON in code fences or prose and use curly quotes, so structured-output mode
 * is unreliable; callers asking for JSON pass the model's text through here.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== "string") throw new TypeError("extractJson expects a string");
  let s = text
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/`/g, "")
    .replace(/[​-‍﻿]/g, "");
  const m = /(\{[\s\S]*?\}|\[[\s\S]*?\])/.exec(s);
  if (!m) throw new Error("extractJson: no JSON object or array found");
  try {
    return JSON.parse(m[0].trim());
  } catch (e) {
    throw new Error(`extractJson: parse failed for ${JSON.stringify(m[0].slice(0, 120))}: ${(e as Error).message}`);
  }
}
