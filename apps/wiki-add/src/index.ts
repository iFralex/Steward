#!/usr/bin/env -S node --import tsx
/**
 * `wiki-add` — add files/folders on disk to the current LLM Wiki project.
 *
 *   wiki-add <file|folder> ...        add (prompts for name+destination or shared folder)
 *   wiki-add --list <folder> ...      print ingestible candidates (for a picker)
 *   wiki-add --pick <file|folder> ... native multi-select picker, then add chosen
 *   wiki-add --root <dir> <file> ...  add picked files, mirrored relative to <dir> (no prompt)
 *
 * Copies into the project's raw/sources/ (snapshot) and asks the running app to
 * rescan; if the app is closed, the files are ingested on its next open.
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { resolveProjectPath, resolveSourcesDir } from "../../llm-wiki/mcp-server/src/project-path.ts";
import { LlmWikiApiClient } from "../../llm-wiki/mcp-server/src/api-client.ts";
import {
  applyPlans, collectCandidates, isInsideDir, loadManifest, planForChosenPath, planFromInputs, planFromRoot,
  withDestinationPrefix, type PlannedCopy,
} from "./core.ts";
import { pickFromFolder } from "./pick.ts";
import { chooseDestinationFolder, chooseSaveFileName, warnOutsideSources } from "./destination-prompt.ts";

async function rescan(): Promise<boolean> {
  try { await new LlmWikiApiClient({ baseUrl: process.env.LLM_WIKI_API_BASE_URL }).rescan(); return true; }
  catch { return false; }
}

/** Single file/folder: "Save as…" panel lets the user rename and/or move it. Returns null if cancelled or rejected. */
async function promptSingleItem(input: string, sourcesDir: string, projectPath: string): Promise<PlannedCopy[] | null> {
  let st; try { st = statSync(input); } catch { return []; }
  const manifest = loadManifest(projectPath);
  const prior = st.isFile() ? manifest[input] : undefined;
  const defaultName = prior ? basename(prior) : basename(input.replace(/\/+$/, ""));
  const priorDir = prior ? join(sourcesDir, dirname(prior)) : sourcesDir;
  const defaultLocation = existsSync(priorDir) ? priorDir : sourcesDir;

  const chosen = await chooseSaveFileName({ prompt: "Salva in LLM Wiki come:", defaultName, defaultLocation });
  if (!chosen) return null;
  if (!isInsideDir(sourcesDir, chosen)) { await warnOutsideSources(sourcesDir); return null; }
  return planForChosenPath(input, chosen, sourcesDir);
}

/** Multiple items: folder browser picks one shared destination; original names/mirroring are kept. */
async function promptSharedFolder(basePlans: PlannedCopy[], sourcesDir: string): Promise<PlannedCopy[] | null> {
  const chosenDir = await chooseDestinationFolder({ prompt: "Scegli la cartella di destinazione in LLM Wiki:", defaultLocation: sourcesDir });
  if (!chosenDir) return null;
  if (!isInsideDir(sourcesDir, chosenDir)) { await warnOutsideSources(sourcesDir); return null; }
  return withDestinationPrefix(basePlans, relative(sourcesDir, chosenDir));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "--list") {
    for (const f of collectCandidates(args.slice(1))) console.log(f);
    return;
  }

  const sourcesDir = resolveSourcesDir();
  const projectPath = resolveProjectPath();

  // --pick: for each folder, show a native picker; files are added as-is.
  if (args[0] === "--pick") {
    const inputs = args.slice(1);
    if (inputs.length === 0) { console.error("usage: wiki-add --pick <file|folder> ..."); process.exit(2); }
    const groups: { root?: string; files: string[] }[] = [];
    for (const input of inputs) {
      let st; try { st = statSync(input); } catch { continue; }
      if (st.isDirectory()) {
        const picked = await pickFromFolder(input);
        if (picked.length > 0) groups.push({ root: input, files: picked });
      } else if (st.isFile()) {
        groups.push({ files: [input] });
      }
    }
    const allFiles = groups.flatMap((g) => g.files);
    if (allFiles.length === 0) { await addAndReport([], sourcesDir, projectPath); return; }

    const plans = allFiles.length === 1
      ? await promptSingleItem(allFiles[0], sourcesDir, projectPath)
      : await promptSharedFolder(groups.flatMap((g) => (g.root ? planFromRoot(g.files, g.root) : planFromInputs(g.files))), sourcesDir);
    if (plans === null) return; // cancelled or invalid destination
    await addAndReport(plans, sourcesDir, projectPath);
    return;
  }

  let root: string | undefined;
  let inputs = args;
  if (args[0] === "--root") { root = args[1]; inputs = args.slice(2); }
  if (inputs.length === 0) {
    console.error("usage: wiki-add [--list|--pick] [--root <dir>] <file|folder> ...");
    process.exit(2);
  }

  let plans: PlannedCopy[] | null;
  if (root) {
    plans = planFromRoot(inputs, root); // internal/manual entry point, not prompted
  } else if (inputs.length === 1) {
    plans = await promptSingleItem(inputs[0], sourcesDir, projectPath);
  } else {
    plans = await promptSharedFolder(planFromInputs(inputs), sourcesDir);
  }
  if (plans === null) return; // cancelled or invalid destination
  await addAndReport(plans, sourcesDir, projectPath);
}

async function addAndReport(plans: PlannedCopy[], sourcesDir: string, projectPath: string): Promise<void> {
  if (plans.length === 0) {
    console.log(JSON.stringify({ added: 0, updated: 0, skipped: 0, message: "no ingestible files" }));
    return;
  }
  const res = applyPlans(plans, sourcesDir, projectPath);
  const rescanned = res.added.length + res.updated.length > 0 ? await rescan() : false;
  console.log(JSON.stringify({ added: res.added.length, updated: res.updated.length, skipped: res.skipped, rescanned, sourcesDir }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
