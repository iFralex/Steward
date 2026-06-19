import { execFile } from "node:child_process";

/** Run an AppleScript via osascript and resolve its stdout. Mirror is the only AppleScript user here. */
export function runOsa(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || "osascript failed"));
      else resolve(stdout);
    });
  });
}
