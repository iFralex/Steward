import { readdirSync, statSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmlxEntry } from "./types.ts";

export function findMailRoot(home: string = homedir()): string | null {
  const mailDir = join(home, "Library", "Mail");
  let versions: string[];
  try {
    versions = readdirSync(mailDir).filter((d) => /^V\d+$/.test(d));
  } catch {
    return null;
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10));
  return join(mailDir, versions[0]);
}

export function canRead(dir: string): boolean {
  try {
    accessSync(dir, constants.R_OK);
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

export function enumerateEmlx(mailRoot: string): EmlxEntry[] {
  const out: EmlxEntry[] = [];
  walk(mailRoot, mailRoot, out);
  return out;
}

export function entryForPath(mailRoot: string, path: string, mtimeMs: number): import("./types.ts").EmlxEntry {
  const { account, mailbox } = accountAndMailbox(mailRoot, path);
  return { path, account, mailbox, isPartial: path.endsWith(".partial.emlx"), mtimeMs };
}

function accountAndMailbox(mailRoot: string, filePath: string): { account: string; mailbox: string } {
  const rel = filePath.slice(mailRoot.length + 1);
  const parts = rel.split("/");
  const account = parts[0] ?? "";
  const mboxPart = parts.find((p) => p.endsWith(".mbox")) ?? "";
  return { account, mailbox: mboxPart.replace(/\.mbox$/, "") };
}

function walk(mailRoot: string, dir: string, out: EmlxEntry[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(mailRoot, full, out);
    } else if (name.endsWith(".emlx")) {
      const { account, mailbox } = accountAndMailbox(mailRoot, full);
      out.push({ path: full, account, mailbox, isPartial: name.endsWith(".partial.emlx"), mtimeMs: st.mtimeMs });
    }
  }
}
