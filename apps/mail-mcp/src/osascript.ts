import { execFile } from "node:child_process";

export type OsaExec = (script: string, timeoutMs: number) => Promise<string>;

export function mapOsaError(stderr: string): string {
  if (/-600\b|isn.t running/i.test(stderr)) {
    return "Mail.app is not running. Open Mail and try again.";
  }
  if (/-1743\b|Not authorized/i.test(stderr)) {
    return "Automation permission for Mail is not granted. Allow it in System Settings → Privacy & Security → Automation.";
  }
  return stderr.trim() || "osascript failed";
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
  return exec(script, opts.timeoutMs ?? 30_000);
}
