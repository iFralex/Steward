import { isAbsolute, normalize } from "node:path";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
