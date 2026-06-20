import type { Role } from "./mailbox-roles.ts";

const ROLES: Role[] = ["inbox", "drafts", "sent", "trash", "junk", "archive", "important", "flagged"];

export interface ClassifyConfig { endpoint: string; model: string; apiKey?: string }

/** Build a best-effort mailbox-name→role classifier over an OpenAI-compatible chat endpoint. */
export function makeRoleClassifier(cfg: ClassifyConfig, fetchImpl: typeof fetch = fetch): (name: string) => Promise<Role | null> {
  return async (name: string) => {
    try {
      const res = await fetchImpl(cfg.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: "system", content: `Classify an email mailbox/folder name into exactly one of: ${ROLES.join(", ")}, or "none". Reply with only the single word.` },
            { role: "user", content: name },
          ],
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const word = (data.choices?.[0]?.message?.content ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
      return (ROLES as string[]).includes(word) ? (word as Role) : null;
    } catch {
      return null;
    }
  };
}

export function loadRoleClassifier(env: NodeJS.ProcessEnv = process.env): ((name: string) => Promise<Role | null>) | undefined {
  // Default to the unified LLM gateway (sub-project 3). Override with
  // MAIL_CLASSIFY_ENDPOINT/MODEL; set MAIL_CLASSIFY_ENDPOINT=off (or "") to disable.
  const endpoint = env.MAIL_CLASSIFY_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions";
  if (!endpoint || endpoint === "off") return undefined;
  return makeRoleClassifier({ endpoint, model: env.MAIL_CLASSIFY_MODEL ?? "local-chat", apiKey: env.MAIL_CLASSIFY_API_KEY });
}
