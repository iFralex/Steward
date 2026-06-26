import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function actionCenterDir(): string {
  const dir = process.env.ACTION_CENTER_DIR ?? join(homedir(), "Library", "Application Support", "action-center");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function actionDbPath(): string {
  return process.env.ACTION_CENTER_DB ?? join(actionCenterDir(), "actions.db");
}
