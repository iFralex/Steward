import { extractJson } from "../../llm-gateway/src/extract-json.ts";
import type { DistilledNote } from "./note.ts";
import type { Chat } from "./llm.ts";

const SYSTEM =
  `Distil an email into durable memory. Reply with ONLY JSON: ` +
  `{"summary": string, "facts": string[], "commitments": string[], "people": string[], "orgs": string[]}. ` +
  `summary: 1-3 sentences. facts: concrete durable facts. commitments: requests/promises (who owes what). ` +
  `people/orgs: named entities. Keep it faithful; do not invent.`;

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function distill(
  msg: { fromName: string; fromAddr: string; subject: string; bodyText: string },
  chat: Chat,
): Promise<DistilledNote | null> {
  const user = `From: ${msg.fromName} <${msg.fromAddr}>\nSubject: ${msg.subject}\n\n${msg.bodyText.slice(0, 8000)}`;
  try {
    const out = (await chat(SYSTEM, user)) as string;
    const p = extractJson(out) as Record<string, unknown>;
    if (typeof p.summary !== "string" || !p.summary.trim()) return null;
    return { summary: p.summary, facts: strs(p.facts), commitments: strs(p.commitments), people: strs(p.people), orgs: strs(p.orgs) };
  } catch {
    return null;
  }
}
