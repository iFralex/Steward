import { runOsa as sharedRunOsa, type OsaExec, type OsaOptions } from "@llm-wiki/applescript";

export type { OsaExec };

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
  opts: { timeoutMs?: number; exec?: OsaExec; isTransient?: (message: string) => boolean } = {},
): Promise<string> {
  const full: OsaOptions = { ...opts, mapError: mapOsaError };
  return sharedRunOsa(script, full);
}
