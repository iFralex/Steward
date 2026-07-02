import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Path of the wiki project the desktop app currently has open. Reads the app's
 * saved state (last-opened project); override with WIKI_PROJECT_PATH. Shared by
 * the mail promoter and the file "add to wiki" CLI so both target the same project.
 */
export function resolveProjectPath(): string {
  const override = process.env.WIKI_PROJECT_PATH
  if (override) return override
  const stateFile = join(homedir(), "Library/Application Support/com.llmwiki.app/app-state.json")
  const st = JSON.parse(readFileSync(stateFile, "utf8")) as { lastProject?: { path?: string }; currentProject?: { path?: string } }
  const p = st.lastProject?.path ?? st.currentProject?.path
  if (!p) throw new Error("Cannot resolve the wiki project path; open a project in the app or set WIKI_PROJECT_PATH")
  return p
}

/** The project's `raw/sources/` directory — where new source files are dropped. */
export function resolveSourcesDir(): string {
  return process.env.MAIL_PROMOTER_WIKI_SOURCES_DIR
    ?? process.env.WIKI_SOURCES_DIR
    ?? join(resolveProjectPath(), "raw", "sources")
}
