import { extractJson } from "../../llm-gateway/src/extract-json.ts";
import type { Chat } from "./llm.ts";
import { cleanBody } from "./clean-body.ts";

const CATEGORIES = ["commitment", "document", "personal-fact", "decision", "relationship"];
const SYSTEM =
  `You decide whether an email holds DURABLE PERSONAL KNOWLEDGE worth saving to long-term memory ` +
  `(requests/commitments, important documents, personal facts, decisions, relationships) vs noise ` +
  `(marketing, notifications, one-off transactional). Reply with ONLY JSON: ` +
  `{"promote": boolean, "categories": string[]} where categories ⊆ ${JSON.stringify(CATEGORIES)}.`;

export async function classify(
  msg: { fromName: string; fromAddr: string; subject: string; bodyText: string },
  chat: Chat,
): Promise<{ promote: boolean; categories: string[] } | null> {
  const user = `From: ${msg.fromName} <${msg.fromAddr}>\nSubject: ${msg.subject}\n\n${cleanBody(msg.bodyText).slice(0, 4000)}`;
  try {
    const out = (await chat(SYSTEM, user)) as string;
    const parsed = extractJson(out) as { promote?: unknown; categories?: unknown };
    if (typeof parsed.promote !== "boolean") return null;
    const cats = Array.isArray(parsed.categories) ? parsed.categories.filter((c): c is string => typeof c === "string" && CATEGORIES.includes(c)) : [];
    return { promote: parsed.promote, categories: cats };
  } catch {
    return null;
  }
}
