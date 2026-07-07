/**
 * Native macOS panels asking where (and, for a single item, how to name) a
 * file/folder should land inside the wiki's raw/sources/. GUI-only glue, kept
 * thin like pick.ts — the resulting path is validated/planned by the tested
 * functions in core.ts.
 */
import { esc, runOsa } from "@steward/applescript";

/** These are modal dialogs waiting on the user, not automation — give them minutes, not runOsa's 30s default. */
const INTERACTIVE_TIMEOUT_MS = 5 * 60_000;

async function runChoose(script: string): Promise<string | null> {
  try {
    const out = await runOsa(script, { timeoutMs: INTERACTIVE_TIMEOUT_MS });
    const path = out.trim();
    return path.length > 0 ? path : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/-128\b/.test(message)) return null; // user cancelled
    throw err;
  }
}

/** "Save as…" panel: lets the user rename and/or move a single file/folder. */
export function chooseSaveFileName(opts: { prompt: string; defaultName: string; defaultLocation: string }): Promise<string | null> {
  const script = [
    `set loc to POSIX file "${esc(opts.defaultLocation)}" as alias`,
    `set target to choose file name with prompt "${esc(opts.prompt)}" default name "${esc(opts.defaultName)}" default location loc`,
    `return POSIX path of target`,
  ].join("\n");
  return runChoose(script);
}

/** Folder browser (with "New Folder"): lets the user pick a shared destination for multiple items. */
export function chooseDestinationFolder(opts: { prompt: string; defaultLocation: string }): Promise<string | null> {
  const script = [
    `set loc to POSIX file "${esc(opts.defaultLocation)}" as alias`,
    `set target to choose folder with prompt "${esc(opts.prompt)}" default location loc`,
    `return POSIX path of target`,
  ].join("\n");
  return runChoose(script);
}

/** Tell the user the chosen destination must stay inside the wiki's raw/sources/. */
export async function warnOutsideSources(sourcesDir: string): Promise<void> {
  const script = `display alert "Destinazione non valida" message "La destinazione deve restare dentro:\n${esc(sourcesDir)}" as warning`;
  try { await runOsa(script, { timeoutMs: INTERACTIVE_TIMEOUT_MS }); } catch { /* best-effort */ }
}
