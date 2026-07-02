#!/usr/bin/env -S node --import tsx
/**
 * `wiki-add` — add files/folders on disk to the current LLM Wiki project.
 *
 *   wiki-add <file|folder> ...        add (folders mirror their structure)
 *   wiki-add --list <folder> ...      print ingestible candidates (for a picker)
 *   wiki-add --root <dir> <file> ...  add picked files, mirrored relative to <dir>
 *
 * Copies into the project's raw/sources/ (snapshot) and asks the running app to
 * rescan; if the app is closed, the files are ingested on its next open.
 */
import { resolveProjectPath, resolveSourcesDir } from "../../llm-wiki/mcp-server/src/project-path.ts";
import { LlmWikiApiClient } from "../../llm-wiki/mcp-server/src/api-client.ts";
import { applyPlans, collectCandidates, planFromInputs, planFromRoot } from "./core.ts";

async function rescan(): Promise<boolean> {
  try { await new LlmWikiApiClient({ baseUrl: process.env.LLM_WIKI_API_BASE_URL }).rescan(); return true; }
  catch { return false; }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "--list") {
    for (const f of collectCandidates(args.slice(1))) console.log(f);
    return;
  }

  let root: string | undefined;
  let inputs = args;
  if (args[0] === "--root") { root = args[1]; inputs = args.slice(2); }
  if (inputs.length === 0) {
    console.error("usage: wiki-add [--list] [--root <dir>] <file|folder> ...");
    process.exit(2);
  }

  const sourcesDir = resolveSourcesDir();
  const projectPath = resolveProjectPath();
  const plans = root ? planFromRoot(inputs, root) : planFromInputs(inputs);
  if (plans.length === 0) {
    console.log(JSON.stringify({ added: 0, updated: 0, skipped: 0, message: "no ingestible files" }));
    return;
  }
  const res = applyPlans(plans, sourcesDir, projectPath);
  const rescanned = res.added.length + res.updated.length > 0 ? await rescan() : false;
  console.log(JSON.stringify({ added: res.added.length, updated: res.updated.length, skipped: res.skipped, rescanned, sourcesDir }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
