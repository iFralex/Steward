import type { Role } from "./mailbox-roles.ts";

const ROLES: Role[] = ["inbox", "drafts", "sent", "trash", "junk", "archive", "important", "flagged"];

export interface ClassifyConfig { endpoint: string; model: string; apiKey?: string }

/**
 * Map a mailbox/folder name (any language) to one standard role, else "none".
 * Glosses each role with multilingual synonyms; instructs "none" for anything
 * that is not clearly a system mailbox (topical/custom folders, project names).
 */
const SYSTEM_PROMPT = [
  "You map an email mailbox/folder name to exactly ONE standard role, or \"none\".",
  "Folder names may be in any language. Roles and their meaning:",
  "- inbox: incoming mail (e.g. Inbox, Posta in arrivo, Bandeja de entrada)",
  "- sent: sent mail (e.g. Sent, Posta inviata, Inviata, Enviados)",
  "- drafts: unsent drafts (e.g. Drafts, Bozze, Borradores)",
  "- trash: deleted mail (e.g. Trash, Bin, Cestino, Deleted Messages, Eliminata)",
  "- junk: spam / unwanted / quarantine (e.g. Junk, Spam, Posta indesiderata, Indesiderata, Bulk, Quarantena)",
  "- archive: archived / all-mail (e.g. Archive, Archivio, All Mail, Tutti i messaggi)",
  "- important: priority mail (e.g. Important, Importante)",
  "- flagged: flagged / starred mail (e.g. Flagged, Starred, Con contrassegno)",
  "Answer \"none\" for anything that is not clearly one of these system mailboxes:",
  "topical or custom folders, labels, project or people names, and similar.",
  "Reply with ONLY the single lowercase word and nothing else.",
].join("\n");

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
            { role: "system", content: SYSTEM_PROMPT },
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
  // tier-2 classifies mailbox names at 18/18 on a labelled IT+EN set with the
  // richer prompt; the gateway escalates up on failure. Override with MAIL_CLASSIFY_MODEL.
  return makeRoleClassifier({ endpoint, model: env.MAIL_CLASSIFY_MODEL ?? "tier-2", apiKey: env.MAIL_CLASSIFY_API_KEY });
}
