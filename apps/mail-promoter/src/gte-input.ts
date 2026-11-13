import type { ThreadInput } from "./thread-input.ts";
import { cleanBody } from "./clean-body.ts";

export const GTE_INPUT_VERSION = 1;

/** Same untruncated serialization used by tools/mail-detection/prepare-thread.mjs. */
export function buildGteInput(input: ThreadInput, userAddrs: string[], decisionAt: number): string {
  const own = new Set(userAddrs.map(s => s.toLowerCase()));
  const rendered = input.messages.map(m => {
    const participation = own.has(m.fromAddr.toLowerCase()) ? "sender"
      : [...m.to, ...m.cc].some(a => own.has(a.toLowerCase())) ? "recipient" : "not directly addressed";
    return `--- ${new Date(m.date * 1000).toISOString().slice(0, 10)}; user is ${participation}; from ${m.fromName} <${m.fromAddr}> ---\n${cleanBody(m.bodyText)}`;
  });
  return `Decision date: ${new Date(decisionAt * 1000).toISOString().slice(0, 10)}\nSubject: ${input.subject}\n\n${rendered.join("\n\n")}`;
}
