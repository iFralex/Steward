import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One-time, non-destructive migration of a legacy data path (a file or a whole
 * directory) to its new location after the LLM Wiki → Steward rename. Moves ONLY
 * when the new path does not exist yet and the legacy one does; never deletes;
 * idempotent (safe to call on every startup). Best-effort: any failure is
 * swallowed so a migration hiccup can never block startup — the caller then just
 * creates a fresh path.
 */
export function migrateLegacyPath(legacyPath: string, currentPath: string): void {
  try {
    if (existsSync(currentPath) || !existsSync(legacyPath)) return;
    mkdirSync(dirname(currentPath), { recursive: true });
    renameSync(legacyPath, currentPath);
  } catch {
    /* best-effort — leave the legacy path untouched and let the caller create a new one */
  }
}
