import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function stateDbPath(): string {
  const dir = join(homedir(), "Library", "Application Support", "mail-promoter");
  mkdirSync(dir, { recursive: true });
  return join(dir, "state.db");
}
