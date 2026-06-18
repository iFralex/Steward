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
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return;
    }
    await ingestEmlxFile(deps, entryForPath(mailRoot, path, mtimeMs));
  };

  const onUnlink = (path: string) => {
    if (!path.endsWith(".emlx")) return;
    const id = deps.store.getMessageIdByPath(path);
    if (id) deps.store.softDelete(id);
  };

  watcher
    .on("add", onUpsert)
    .on("change", onUpsert)
    .on("unlink", onUnlink)
    .on("error", (err) => console.error("[mail-mirror watcher]", err));
  return { close: () => watcher.close() };
}
