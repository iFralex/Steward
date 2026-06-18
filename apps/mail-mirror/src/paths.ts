import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function storeDir(): string {
  const dir = process.env.MAIL_MIRROR_DIR ?? join(homedir(), "Library", "Application Support", "mail-mirror");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function dbPath(): string {
  return join(storeDir(), "mail.db");
}

export function blobsDir(): string {
  return join(storeDir(), "blobs");
}
