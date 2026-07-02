/**
 * The "Scegli…" picker: show a native multi-selection list (osascript) of a
 * folder's ingestible files and return the chosen absolute paths. GUI-only, so
 * kept thin — the selection/copy logic lives in the tested core.
 */
import { execFile } from "node:child_process";
import { relative } from "node:path";
import { collectCandidates } from "./core.ts";

export function pickFromFolder(folder: string): Promise<string[]> {
  const candidates = collectCandidates([folder]);
  if (candidates.length === 0) return Promise.resolve([]);
  const rels = candidates.map((c) => relative(folder, c));
  const relToAbs = new Map(rels.map((r, i) => [r, candidates[i]] as const));
  const listLiteral = rels.map((r) => `"${r.replace(/[\\"]/g, "\\$&")}"`).join(", ");
  const script = [
    `set theList to {${listLiteral}}`,
    `set AppleScript's text item delimiters to linefeed`,
    `set chosen to choose from list theList with title "LLM Wiki" with prompt "Scegli i file da aggiungere alla wiki:" with multiple selections allowed`,
    `if chosen is false then return ""`,
    `return chosen as text`,
  ].join("\n");
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      const picked = (stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      resolve(picked.map((r) => relToAbs.get(r)).filter((x): x is string => !!x));
    });
  });
}
