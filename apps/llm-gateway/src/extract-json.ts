/**
 * Lenient JSON extraction for free-model output. Free `api-*` models often wrap
 * JSON in code fences or prose and use curly quotes, so structured-output mode
 * is unreliable; callers asking for JSON pass the model's text through here.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== "string") throw new TypeError("extractJson expects a string");
  const s = text
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/`/g, "")
    .replace(/[​-‍﻿]/g, "");
  const start = s.search(/[{[]/);
  if (start < 0) throw new Error("extractJson: no JSON object or array found");
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error("extractJson: unbalanced JSON");
  const frag = s.slice(start, end + 1);
  try {
    return JSON.parse(frag);
  } catch (e) {
    throw new Error(`extractJson: parse failed for ${JSON.stringify(frag.slice(0, 120))}: ${(e as Error).message}`);
  }
}
