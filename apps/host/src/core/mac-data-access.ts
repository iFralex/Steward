import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function probeLocalData(directory: string, database?: string): { ok: boolean; verified: boolean; detail: string; detailKey: string; detailValues?: Record<string, string> } {
  try {
    readdirSync(directory);
    if (database) {
      const fd = openSync(join(directory, database), "r");
      try { readSync(fd, Buffer.alloc(1), 0, 1, 0); }
      finally { closeSync(fd); }
    }
    return { ok: true, verified: true, detail: "Local data read succeeded", detailKey: "system.permissions.readSucceeded" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false, verified: false,
      detailKey: code === "EPERM" || code === "EACCES" ? "system.permissions.readDenied" : "system.permissions.readUnverified",
      detailValues: { code: code ?? "unknown" },
      detail: code === "EPERM" || code === "EACCES"
        ? "Local data access denied. Check Steward Full Disk Access and restart if macOS requires it."
        : `Local data could not be verified (${code ?? "unknown error"}); data may be absent.`,
    };
  }
}
