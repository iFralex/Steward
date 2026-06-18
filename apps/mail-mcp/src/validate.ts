import { isAbsolute, normalize } from "node:path";
import type { MessageRef } from "./types.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a message locator and report which lookup path to use.
 * A native numeric `id` (digits only) is preferred — it maps to the
 * indexed, fast `whose id is` predicate. Otherwise an RFC `messageId`
 * is used with the slow `whose message id is` path.
 */
export function resolveMessageRef(ref: MessageRef): { byId: true; id: string } | { byId: false; messageId: string } {
  const id = ref.id != null ? String(ref.id).trim() : "";
  if (id) {
    if (!/^\d+$/.test(id)) throw new Error(`invalid message id (must be Mail's numeric id): ${id}`);
    return { byId: true, id };
  }
  const messageId = ref.messageId != null ? String(ref.messageId).trim() : "";
  if (messageId) return { byId: false, messageId };
  throw new Error("a message id is required (pass the `id` from a search result)");
}

export function isEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

export function assertEmails(list: string[], field: string): void {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${field}: at least one recipient is required`);
  }
  for (const addr of list) {
    if (!isEmail(addr)) throw new Error(`${field}: invalid email "${addr}"`);
  }
}

/** Validate an optional destination directory for saved attachments. */
export function assertSafeDestPath(destDir: string): string {
  if (!isAbsolute(destDir)) throw new Error(`destDir must be an absolute path: ${destDir}`);
  const norm = normalize(destDir);
  if (norm.split("/").includes("..")) throw new Error(`destDir must not contain "..": ${destDir}`);
  return norm;
}
