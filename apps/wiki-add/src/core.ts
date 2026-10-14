/**
 * Core of "add to LLM Wiki": copy selected files/folders into the project's
 * raw/sources/ (a snapshot), preserving folder hierarchy, skipping junk, and
 * de-duplicating re-adds by origin path (a manifest at the project root). The
 * wiki's recursive rescan then ingests them.
 */
import { lstatSync, realpathSync, readdirSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDestination } from "@steward/source-collision/node";

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
  try { const st = lstatSync(path); return st.isFile() && st.size <= maxBytes; } catch { return false; }
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
      let st; try { st = lstatSync(p); } catch { continue; }
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
    let st; try { st = lstatSync(input); } catch { continue; }
    if (st.isDirectory()) out.push(...walkIngestible(input, maxBytes));
    else if (st.isFile() && isIngestibleFile(input, maxBytes)) out.push(input);
  }
  return [...new Set(out)];
}

/** A source file and where it should land, relative to raw/sources/. */
export interface PlannedCopy { src: string; targetRel: string; destinationChosen?: boolean }

/** Plan targets: folders mirror under <folder-name>/…; loose files go flat. */
export function planFromInputs(inputs: string[], maxBytes = DEFAULT_MAX_BYTES): PlannedCopy[] {
  const plans: PlannedCopy[] = [];
  for (const input of inputs) {
    let st; try { st = lstatSync(input); } catch { continue; }
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

/** True if `target` is `root` itself or nested inside it. */
export function isInsideDir(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

/** Prepend a relative destination prefix (e.g. from a user-chosen shared folder) to every plan's target. */
export function withDestinationPrefix(plans: PlannedCopy[], prefixRel: string): PlannedCopy[] {
  return plans.map((p) => ({ ...p, targetRel: !prefixRel || prefixRel === "." ? p.targetRel : join(prefixRel, p.targetRel), destinationChosen: true }));
}

/** Plan a single file/folder input against a destination path the user chose explicitly (name + folder). */
export function planForChosenPath(input: string, chosenAbsPath: string, sourcesDir: string, maxBytes = DEFAULT_MAX_BYTES): PlannedCopy[] {
  const rel = relative(sourcesDir, chosenAbsPath);
  let st; try { st = lstatSync(input); } catch { return []; }
  if (st.isDirectory()) {
    return walkIngestible(input, maxBytes).map((f) => ({ src: f, targetRel: join(rel, relative(input, f)), destinationChosen: true }));
  }
  if (st.isFile() && isIngestibleFile(input, maxBytes)) {
    return [{ src: input, targetRel: rel, destinationChosen: true }];
  }
  return [];
}

export interface AddResult { added: PlannedCopy[]; updated: PlannedCopy[]; unchanged: PlannedCopy[]; skipped: number }

type Manifest = Record<string, string>; // origin absolute path -> target relative to raw/sources/
const MANIFEST_NAME = ".llmwiki-added.json";

export function loadManifest(projectPath: string): Manifest {
  try { return JSON.parse(readFileSync(join(projectPath, MANIFEST_NAME), "utf8")) as Manifest; } catch { return {}; }
}
export function saveManifest(projectPath: string, m: Manifest): void {
  const final = join(projectPath, MANIFEST_NAME);
  const temp = `${final}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(m, null, 2), { mode: 0o600, flag: 'wx' });
  renameSync(temp, final);
}

/** Copy planned files into raw/sources/, de-duplicating re-adds by origin path and
 * never silently overwriting a different, unrelated file that happens to share a name. */
/** Reject symlink escapes, including non-existent descendants of a symlinked directory. */
export function safeDestination(sourcesDir: string, targetRel: string): string {
  if (isAbsolute(targetRel) || !targetRel || targetRel.split(/[\\/]/).includes('..')) throw new Error('Destination must remain inside wiki sources');
  const root = realpathSync(sourcesDir);
  const target = resolve(root, targetRel);
  if (!isInsideDir(root, target) || target === root) throw new Error('Destination escapes wiki sources');
  let ancestor = target;
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (stat.isSymbolicLink()) throw new Error('Symlink destinations are not allowed');
      if (!isInsideDir(root, realpathSync(ancestor))) throw new Error('Resolved destination escapes wiki sources');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (ancestor === root) break;
    ancestor = dirname(ancestor);
  }
  return target;
}

export function applyPlans(plans: PlannedCopy[], sourcesDir: string, projectPath: string): AddResult {
  mkdirSync(sourcesDir, { recursive: true });
  const lock = join(projectPath, '.llmwiki-added.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another wiki import is active. If a prior importer crashed, remove .llmwiki-added.lock after verifying it stopped.'); throw error; }
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    const manifest = loadManifest(projectPath);
    const added: PlannedCopy[] = [], updated: PlannedCopy[] = [], unchanged: PlannedCopy[] = [];
    let skipped = 0;
    for (const p of plans) {
      try {
        if (!lstatSync(p.src).isFile()) throw new Error('Source must be a regular file');
        const prior = manifest[p.src];
        const priorTarget = prior ? safeDestination(sourcesDir, prior) : undefined;
        const target = safeDestination(sourcesDir, p.destinationChosen ? p.targetRel : prior ?? p.targetRel);
        const sharedPrior = prior && Object.entries(manifest).some(([origin, destination]) => origin !== p.src && destination === prior);
        const tracked = priorTarget === target && !sharedPrior;
        const content = readFileSync(p.src);
        let decision = resolveDestination(target, content, tracked);
        if (decision.action !== 'skip') {
          mkdirSync(dirname(decision.path), { recursive: true });
          safeDestination(sourcesDir, relative(realpathSync(sourcesDir), decision.path));
          if (decision.action === 'overwrite') {
            const temp = `${decision.path}.${randomUUID()}.tmp`;
            writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
            renameSync(temp, decision.path);
          } else {
            // Never clobber a file created after collision probing by another writer.
            for (let attempts = 0; ; attempts++) {
              try { writeFileSync(decision.path, content, { flag: 'wx', mode: 0o600 }); break; }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempts >= 20) throw error;
                decision = resolveDestination(target, content, false);
                if (decision.action === 'skip') break;
              }
            }
          }
        }
        const targetRel = relative(realpathSync(sourcesDir), decision.path);
        manifest[p.src] = targetRel;
        // Publish the new reference before removing the old snapshot: a crash may
        // leave an extra old file, but never a manifest pointing at a removed file.
        saveManifest(projectPath, manifest);
        if (priorTarget && priorTarget !== decision.path && !Object.values(manifest).includes(prior!)) {
          try { unlinkSync(priorTarget); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const result = { src: p.src, targetRel };
        (prior ? updated : decision.action === 'skip' ? unchanged : added).push(result);
        if (prior && decision.action === 'skip' && priorTarget === decision.path) { updated.pop(); unchanged.push(result); }
      } catch { skipped++; }
    }
    return { added, updated, unchanged, skipped };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
