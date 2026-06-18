import { execFile } from "node:child_process";

export type OsaExec = (script: string, timeoutMs: number) => Promise<string>;

export function mapOsaError(stderr: string): string {
  if (/-600\b|isn.t running/i.test(stderr)) {
    return "Mail.app is not running. Open Mail and try again.";
  }
  if (/-1743\b|Not authorized/i.test(stderr)) {
    return "Automation permission for Mail is not granted. Allow it in System Settings → Privacy & Security → Automation.";
  }
  if (/-609\b|connection is invalid/i.test(stderr)) {
    return "Mail connection was temporarily invalid (-609). Retried.";
  }
  return stderr.trim() || "osascript failed";
}

/** Transient failures worth one automatic retry. */
function isTransient(message: string): boolean {
  return /-609\b|connection is invalid|temporarily invalid/i.test(message);
}

const defaultExec: OsaExec = (script, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(mapOsaError(stderr || err.message)));
        else resolve(stdout);
      },
    );
  });

export async function runOsa(
  script: string,
  opts: { timeoutMs?: number; exec?: OsaExec } = {},
): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    return await exec(script, timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isTransient(message)) throw err;
    await new Promise((r) => setTimeout(r, 300));
    return exec(script, timeoutMs);
  }
}
