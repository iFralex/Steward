import { execFile } from "node:child_process";

/** Escape a string for inclusion inside an AppleScript double-quoted literal. */
export function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export type OsaExec = (script: string, timeoutMs: number) => Promise<string>;

export interface OsaOptions {
  timeoutMs?: number;
  exec?: OsaExec;
  /** Translate raw stderr into a user-facing message. Default: trimmed stderr. */
  mapError?: (stderr: string) => string;
  /** Decide whether a failure message is worth one automatic retry. */
  isTransient?: (message: string) => boolean;
}

function defaultIsTransient(message: string): boolean {
  return /-609\b|connection is invalid|temporarily invalid/i.test(message);
}

const defaultExec: OsaExec = (script, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) { resolve(stdout); return; }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (e.killed || e.signal === "SIGTERM") {
          reject(new Error("osascript timed out"));
        } else {
          reject(new Error((stderr || "osascript failed").trim()));
        }
      },
    );
  });

export async function runOsa(script: string, opts: OsaOptions = {}): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const isTransient = opts.isTransient ?? defaultIsTransient;
  try {
    return await exec(script, timeoutMs);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (!isTransient(raw)) {
      throw new Error(opts.mapError ? opts.mapError(raw) : raw);
    }
    await new Promise((r) => setTimeout(r, 300));
    try {
      return await exec(script, timeoutMs);
    } catch (err2) {
      const raw2 = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(opts.mapError ? opts.mapError(raw2) : raw2);
    }
  }
}
