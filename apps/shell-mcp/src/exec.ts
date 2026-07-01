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

export const OUTPUT_CAP = 1024 * 1024; // 1 MB
export const DEFAULT_TIMEOUT_MS = 15_000;

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
  truncated: boolean;
  error?: string;
}

/** Run an allowlisted binary with execFile (no shell), capping time + output. */
export function runCommand(
  binary: string,
  args: string[],
  opts: { mode: Mode; cwd?: string; timeoutMs?: number } = { mode: "read" },
): Promise<ExecResult> {
  const invalid = validate(binary, args, opts.mode);
  if (invalid) return Promise.resolve({ ok: false, exitCode: null, stdout: "", stderr: "", truncated: false, error: invalid });
  const cwd = opts.cwd ? expandTilde(opts.cwd) : undefined;
  if (cwd && isSensitivePath(cwd)) {
    return Promise.resolve({ ok: false, exitCode: null, stdout: "", stderr: "", truncated: false, error: `cwd blocked (sensitive): ${cwd}` });
  }
  const resolvedArgs = args.map(expandTilde);
  return new Promise<ExecResult>((resolvePromise) => {
    execFile(
      binary, resolvedArgs,
      { cwd, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: OUTPUT_CAP, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        const truncated = !!e && String(e.code) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const timedOut = !!e?.killed;
        resolvePromise({
          ok: !e || truncated,
          exitCode: typeof e?.code === "number" ? e.code : (e ? 1 : 0),
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          truncated,
          error: timedOut ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (e && !truncated ? e.message : undefined),
        });
      },
    );
  });
}
