import { isAbsolute, normalize } from "node:path";
import { isForbiddenWriteDir } from "@steward/sensitive-path";
import type { MessageRef } from "./types.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a message locator and report which lookup path to use.
 * A native numeric `id` (digits only) maps to the indexed, fast `whose id is`
 * predicate. A non-numeric `id` is treated as an RFC Message-ID — the DB-backed
 * search returns the Message-ID in the `id` field (Mail's numeric id is volatile
 * and not stored), so accept it and use the `whose message id is` path instead
 * of rejecting it.
 */
export function resolveMessageRef(ref: MessageRef): { byId: true; id: string } | { byId: false; messageId: string } {
  const id = ref.id != null ? String(ref.id).trim() : "";
  if (id && /^\d+$/.test(id)) return { byId: true, id };
  const messageId = (ref.messageId != null ? String(ref.messageId).trim() : "") || id;
  if (messageId) return { byId: false, messageId };
  throw new Error("a message id is required (pass the `id` or `messageId` from a search result)");
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
  if (isForbiddenWriteDir(norm)) {
    throw new Error(`destDir not allowed (system/persistence/secret location): ${destDir}`);
  }
  return norm;
}
