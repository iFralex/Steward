/**
 * Safe command execution for the shell MCP. No shell is ever spawned
 * (execFile, not exec), so shell metacharacters (| > ; $() ` &&) are inert —
 * they'd be passed as literal argv, never interpreted. Safety = an allowlist of
 * binaries + a denylist of dangerous flags + a sensitive-path guard + output
 * and time caps. Read binaries run freely; write binaries are a separate tool
 * the host gates behind user approval.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";

/** Read-only inspection/search binaries — safe to run without approval. */
export const READ_BINARIES = new Set([
  "ls", "cat", "head", "tail", "file", "stat", "find", "mdfind", "mdls",
  "grep", "egrep", "fgrep", "rg", "wc", "du", "df", "basename", "dirname",
  "realpath", "readlink", "pwd", "sips", "sha256sum", "md5", "cksum",
]);

/** Mutating binaries — only via the gated write tool (approval required). */
export const WRITE_BINARIES = new Set(["cp", "mv", "mkdir", "rmdir", "rm", "ln", "touch"]);

/** Flags that turn an otherwise read-only binary into an executor/mutator. */
const DANGEROUS_FLAGS = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fdelete",
  "-fprint", "-fprint0", "-fprintf", "-fls",
]);

/** Paths whose contents must never be read/written by this tool. */
const SENSITIVE = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.gnupg(\/|$)/,
  /\/Library\/Keychains(\/|$)/, /(^|\/)\.netrc$/, /(^|\/)Cookies(\/|$)/,
  /id_rsa/, /id_ed25519/, /(^|\/)\.env(\.[\w-]+)?$/, /credentials/i,
  /\.pem$/, /\.p12$/, /(^|\/)\.aws\/credentials/,
];

export const OUTPUT_CAP = 1024 * 1024; // 1 MB hard execFile buffer
export const DEFAULT_TIMEOUT_MS = 15_000;
/** How much output is returned to the model by default (keep context small). */
export const DEFAULT_MAX_LINES = 120;
export const DEFAULT_MAX_CHARS = 8_000;

/** Clip text to a line + char budget, so a naive `ls` can't flood the context. */
export function clip(text: string, maxLines: number, maxChars: number): { text: string; clipped: boolean; totalLines: number } {
  const lines = text.split("\n");
  const totalLines = lines.length;
  let clipped = false;
  let out = text;
  if (lines.length > maxLines) { out = lines.slice(0, maxLines).join("\n"); clipped = true; }
  if (out.length > maxChars) { out = out.slice(0, maxChars); clipped = true; }
  return { text: out, clipped, totalLines };
}

/** Expand a leading `~/` (execFile does not do shell tilde expansion). */
export function expandTilde(p: string): string {
  return p.startsWith("~/") || p === "~" ? p.replace(/^~/, homedir()) : p;
}

export function isSensitivePath(value: string): boolean {
  const v = expandTilde(value);
  return SENSITIVE.some((re) => re.test(v));
}

export type Mode = "read" | "write";

/** Validate a binary + argv for a mode. Returns an error string, or null if OK. */
export function validate(binary: string, args: string[], mode: Mode): string | null {
  const allowed = mode === "read" ? READ_BINARIES : WRITE_BINARIES;
  if (!allowed.has(binary)) {
    return `command '${binary}' is not allowed in ${mode} mode. Allowed: ${[...allowed].join(", ")}`;
  }
  for (const a of args) {
    if (DANGEROUS_FLAGS.has(a)) return `flag '${a}' is not allowed (it can execute or delete files)`;
    if (isSensitivePath(a)) return `path blocked (sensitive): ${a}`;
  }
  return null;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True if output was cut (by the line/char budget or the 1 MB buffer). */
  truncated: boolean;
  /** Total stdout lines before clipping (so the model knows how much it missed). */
  totalLines?: number;
  hint?: string;
  error?: string;
}

/** Run an allowlisted binary with execFile (no shell), capping time + output. */
export function runCommand(
  binary: string,
  args: string[],
  opts: { mode: Mode; cwd?: string; timeoutMs?: number; maxLines?: number; maxChars?: number } = { mode: "read" },
): Promise<ExecResult> {
  const invalid = validate(binary, args, opts.mode);
  if (invalid) return Promise.resolve({ ok: false, exitCode: null, stdout: "", stderr: "", truncated: false, error: invalid });
  const cwd = opts.cwd ? expandTilde(opts.cwd) : undefined;
  if (cwd && isSensitivePath(cwd)) {
    return Promise.resolve({ ok: false, exitCode: null, stdout: "", stderr: "", truncated: false, error: `cwd blocked (sensitive): ${cwd}` });
  }
  const resolvedArgs = args.map(expandTilde);
  const maxLines = Math.min(Math.max(opts.maxLines ?? DEFAULT_MAX_LINES, 1), 5000);
  const maxChars = Math.min(Math.max(opts.maxChars ?? DEFAULT_MAX_CHARS, 200), 200_000);
  return new Promise<ExecResult>((resolvePromise) => {
    execFile(
      binary, resolvedArgs,
      { cwd, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: OUTPUT_CAP, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        const bufferOverflow = !!e && String(e.code) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const timedOut = !!e?.killed;
        const out = clip(stdout ?? "", maxLines, maxChars);
        const truncated = out.clipped || bufferOverflow;
        resolvePromise({
          ok: !e || bufferOverflow,
          exitCode: typeof e?.code === "number" ? e.code : (e ? 1 : 0),
          stdout: out.text,
          stderr: clip(stderr ?? "", 40, 2_000).text,
          truncated,
          totalLines: out.totalLines,
          hint: truncated
            ? `Output truncated (showing ${Math.min(maxLines, out.totalLines)} of ${out.totalLines} lines). Narrow with the command's flags (e.g. 'ls -t' for newest-first, 'find … -mtime -N', 'grep -m N') rather than listing everything; raise maxLines only if you truly need more.`
            : undefined,
          error: timedOut ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (e && !bufferOverflow ? e.message : undefined),
        });
      },
    );
  });
}
