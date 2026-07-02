/**
 * Core of "add to LLM Wiki": copy selected files/folders into the project's
 * raw/sources/ (a snapshot), preserving folder hierarchy, skipping junk, and
 * de-duplicating re-adds by origin path (a manifest at the project root). The
 * wiki's recursive rescan then ingests them.
 */
import { statSync, readdirSync, existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

/** File types worth ingesting (docs, text, code, images). */
export const INGEST_EXT = new Set([
  ".pdf", ".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm",
  ".docx", ".doc", ".rtf", ".odt", ".pptx", ".ppt", ".xlsx", ".xls", ".epub", ".tex", ".org", ".log",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".sh", ".sql", ".css", ".scss",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg",
]);

/** Directory names never descended into. */
export const JUNK_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "target", ".next", ".cache",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", "DerivedData", "Pods",
]);

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

export function isIngestibleFile(path: string, maxBytes = DEFAULT_MAX_BYTES): boolean {
  if (basename(path).startsWith(".")) return false;
  if (!INGEST_EXT.has(extname(path).toLowerCase())) return false;
  try { const st = statSync(path); return st.isFile() && st.size <= maxBytes; } catch { return false; }
}

/** Recursively collect ingestible files under a directory (skips junk + hidden). */
export function walkIngestible(dir: string, maxBytes = DEFAULT_MAX_BYTES): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".") || JUNK_DIRS.has(name)) continue;
      const p = join(d, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) visit(p);
      else if (st.isFile() && isIngestibleFile(p, maxBytes)) out.push(p);
    }
  };
  visit(dir);
  return out;
}

/** Expand inputs (files + folders) into the ingestible candidate files. */
export function collectCandidates(inputs: string[], maxBytes = DEFAULT_MAX_BYTES): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    let st; try { st = statSync(input); } catch { continue; }
    if (st.isDirectory()) out.push(...walkIngestible(input, maxBytes));
    else if (st.isFile() && isIngestibleFile(input, maxBytes)) out.push(input);
  }
  return [...new Set(out)];
}

/** A source file and where it should land, relative to raw/sources/. */
export interface PlannedCopy { src: string; targetRel: string }

/** Plan targets: folders mirror under <folder-name>/…; loose files go flat. */
export function planFromInputs(inputs: string[], maxBytes = DEFAULT_MAX_BYTES): PlannedCopy[] {
  const plans: PlannedCopy[] = [];
  for (const input of inputs) {
    let st; try { st = statSync(input); } catch { continue; }
    if (st.isDirectory()) {
      const rootName = basename(input.replace(/\/+$/, ""));
      for (const f of walkIngestible(input, maxBytes)) plans.push({ src: f, targetRel: join(rootName, relative(input, f)) });
    } else if (st.isFile() && isIngestibleFile(input, maxBytes)) {
      plans.push({ src: input, targetRel: basename(input) });
    }
  }
  return plans;
}

/** Plan targets for picked files, mirroring each relative to a root folder. */
export function planFromRoot(files: string[], root: string, maxBytes = DEFAULT_MAX_BYTES): PlannedCopy[] {
  const rootName = basename(root.replace(/\/+$/, ""));
  const plans: PlannedCopy[] = [];
  for (const f of files) {
    if (!isIngestibleFile(f, maxBytes)) continue;
    const rel = relative(root, f);
    plans.push({ src: f, targetRel: rel.startsWith("..") ? basename(f) : join(rootName, rel) });
  }
  return plans;
}

export interface AddResult { added: PlannedCopy[]; updated: PlannedCopy[]; skipped: number }

type Manifest = Record<string, string>; // origin absolute path -> target relative to raw/sources/
const MANIFEST_NAME = ".llmwiki-added.json";

export function loadManifest(projectPath: string): Manifest {
  try { return JSON.parse(readFileSync(join(projectPath, MANIFEST_NAME), "utf8")) as Manifest; } catch { return {}; }
}
export function saveManifest(projectPath: string, m: Manifest): void {
  writeFileSync(join(projectPath, MANIFEST_NAME), JSON.stringify(m, null, 2));
}

function uniqueRel(sourcesDir: string, rel: string): string {
  if (!existsSync(join(sourcesDir, rel))) return rel;
  const dir = dirname(rel);
  const ext = extname(rel);
  const stem = basename(rel, ext);
  const make = (i: number) => (dir === "." ? `${stem} (${i})${ext}` : join(dir, `${stem} (${i})${ext}`));
  let i = 2;
  while (existsSync(join(sourcesDir, make(i)))) i++;
  return make(i);
}

/** Copy planned files into raw/sources/, de-duplicating re-adds by origin path. */
export function applyPlans(plans: PlannedCopy[], sourcesDir: string, projectPath: string): AddResult {
  const manifest = loadManifest(projectPath);
  const added: PlannedCopy[] = [];
  const updated: PlannedCopy[] = [];
  let skipped = 0;
  for (const p of plans) {
    const prior = manifest[p.src];
    const targetRel = prior ?? uniqueRel(sourcesDir, p.targetRel);
    const target = join(sourcesDir, targetRel);
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(p.src, target);
      manifest[p.src] = targetRel;
      (prior ? updated : added).push({ src: p.src, targetRel });
    } catch {
      skipped++;
    }
  }
  saveManifest(projectPath, manifest);
  return { added, updated, skipped };
}
