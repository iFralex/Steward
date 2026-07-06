import { execFile } from "node:child_process";
import { runOsa as sharedRunOsa, type OsaExec, type OsaOptions } from "@steward/applescript";

export type { OsaExec };

export type QuitFn = (bin: string, args: string[]) => Promise<unknown>;

const defaultQuit: QuitFn = (bin, args) =>
  new Promise((resolve, reject) => execFile(bin, args, (err) => (err ? reject(err) : resolve(undefined))));

/**
 * Mail.app can wedge on a bad IMAP/Exchange round-trip and never return from
 * the AppleScript call. Force-quitting it lets the pending attempt's own
 * timeout (or a future call) start from a clean process — `tell application
 * "Mail"` auto-relaunches it on the next script. Best-effort: never rejects,
 * so a missing/already-dead Mail process doesn't surface as a new error.
 */
export function forceQuitMail(quit: QuitFn = defaultQuit): Promise<void> {
  return quit("killall", ["-9", "Mail"]).then(
    () => undefined,
    () => undefined,
  );
}

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
  if (/timed out/i.test(stderr)) {
    return "Mail timed out — the message body may still be downloading from the server (Exchange/IMAP). Try again in a moment.";
  }
  return stderr.trim() || "osascript failed";
}

export async function runOsa(
  script: string,
  opts: {
    timeoutMs?: number;
    exec?: OsaExec;
    isTransient?: (message: string) => boolean;
    onStall?: () => void | Promise<void>;
  } = {},
): Promise<string> {
  const full: OsaOptions = { ...opts, mapError: mapOsaError, onStall: opts.onStall ?? (() => forceQuitMail()) };
  return sharedRunOsa(script, full);
}
