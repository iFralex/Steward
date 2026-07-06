/**
 * The "Scegli…" picker: show a native multi-file picker for a folder and return
 * the chosen absolute paths. GUI-only, so kept thin — the selection/copy logic
 * lives in the tested core.
 */
import { execFile } from "node:child_process";
import { collectCandidates, isIngestibleFile } from "./core.ts";

export function pickFromFolder(folder: string): Promise<string[]> {
  const candidates = collectCandidates([folder]);
  if (candidates.length === 0) return Promise.resolve([]);
  const candidateSet = new Set(candidates);
  const script = [
    `set startFolder to POSIX file "${escapeAppleScript(folder)}" as alias`,
    `set chosen to choose file with prompt "Scegli i file da aggiungere alla wiki:" default location startFolder with multiple selections allowed`,
    `set AppleScript's text item delimiters to linefeed`,
    `set out to {}`,
    `repeat with f in chosen`,
    `  set end of out to POSIX path of f`,
    `end repeat`,
    `return out as text`,
  ].join("\n");
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      const picked = (stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      resolve(picked.filter((path) => candidateSet.has(path) || isIngestibleFile(path)));
    });
  });
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
