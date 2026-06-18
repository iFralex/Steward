import { statSync } from "node:fs";
import chokidar from "chokidar";
import { entryForPath } from "./locator.ts";
import { ingestEmlxFile, type SyncDeps } from "./sync.ts";

export function startWatch(deps: SyncDeps, mailRoot: string): { close(): Promise<void> } {
  const watcher = chokidar.watch(mailRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  const onUpsert = async (path: string) => {
    if (!path.endsWith(".emlx")) return;
    let mtimeMs = Date.now();
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return;
    }
    await ingestEmlxFile(deps, entryForPath(mailRoot, path, mtimeMs));
  };

  const onUnlink = (path: string) => {
    if (!path.endsWith(".emlx")) return;
    const row = deps.store.raw.prepare("SELECT message_id FROM messages WHERE emlx_path=?").get(path) as { message_id: string } | undefined;
    if (row) deps.store.softDelete(row.message_id);
  };

  watcher.on("add", onUpsert).on("change", onUpsert).on("unlink", onUnlink);
  return { close: () => watcher.close() };
}
