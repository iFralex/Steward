import { spawn } from "node:child_process";

/** Run a command to completion. Rejects on non-zero exit or timeout. */
export function exec(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], cwd: opts.cwd });
    let err = "";
    child.stderr?.on("data", (d) => { err += d.toString(); });
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`timed out after ${opts.timeoutMs}ms`)); }, opts.timeoutMs)
      : undefined;
    child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}${err ? `: ${err.trim().slice(0, 300)}` : ""}`));
    });
  });
}
