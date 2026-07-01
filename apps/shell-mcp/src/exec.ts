/**
 * Safe command execution for the shell MCP. No shell is ever spawned
 * (execFile, not exec), so shell metacharacters (| > ; $() ` &&) are inert —
 * they'd be passed as literal argv, never interpreted. Safety = an allowlist of
 * binaries + a denylist of dangerous flags + a sensitive-path guard + output
 * and time caps. Read binaries run freely; write binaries are a separate tool
 * the host gates behind user approval.
 */
import { execFile, spawn } from "node:child_process";
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

const clampLines = (n?: number) => Math.min(Math.max(n ?? DEFAULT_MAX_LINES, 1), 5000);
const clampChars = (n?: number) => Math.min(Math.max(n ?? DEFAULT_MAX_CHARS, 200), 200_000);
const fail = (error: string): ExecResult => ({ ok: false, exitCode: null, stdout: "", stderr: "", truncated: false, error });
const TRUNCATE_HINT = "Output truncated. Narrow it (command flags like 'ls -t' / 'find -mtime -N' / 'grep -m N', or a '| head' stage) or raise maxLines only if truly needed.";

/** Run an allowlisted binary with execFile (no shell), capping time + output. */
export function runCommand(
  binary: string,
  args: string[],
  opts: { mode: Mode; cwd?: string; timeoutMs?: number; maxLines?: number; maxChars?: number } = { mode: "read" },
): Promise<ExecResult> {
  const invalid = validate(binary, args, opts.mode);
  if (invalid) return Promise.resolve(fail(invalid));
  const cwd = opts.cwd ? expandTilde(opts.cwd) : undefined;
  if (cwd && isSensitivePath(cwd)) return Promise.resolve(fail(`cwd blocked (sensitive): ${cwd}`));
  const resolvedArgs = args.map(expandTilde);
  const maxLines = clampLines(opts.maxLines);
  const maxChars = clampChars(opts.maxChars);
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
          hint: truncated ? `Showing ${Math.min(maxLines, out.totalLines)} of ${out.totalLines} lines. ${TRUNCATE_HINT}` : undefined,
          error: timedOut ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (e && !bufferOverflow ? e.message : undefined),
        });
      },
    );
  });
}

export interface Stage { command: string; args?: string[]; }

/**
 * Run a read-only pipeline: stage[i] stdout feeds stage[i+1] stdin, like a shell
 * `|` — but NO shell is used. Each stage is spawned as an allowlisted binary
 * with explicit argv and the streams are wired in Node, so metacharacters stay
 * literal and every stage is validated independently. `head`/`tail` closing
 * early (EPIPE upstream) is normal and ignored.
 */
export function runPipeline(
  stages: Stage[],
  opts: { cwd?: string; timeoutMs?: number; maxLines?: number; maxChars?: number } = {},
): Promise<ExecResult> {
  if (!stages.length) return Promise.resolve(fail("pipeline needs at least one stage"));
  if (stages.length > 6) return Promise.resolve(fail("pipeline too long (max 6 stages)"));
  const norm = stages.map((s) => ({ command: s.command, args: (s.args ?? []).map(expandTilde) }));
  for (const s of norm) {
    const invalid = validate(s.command, s.args, "read");
    if (invalid) return Promise.resolve(fail(`stage '${s.command}': ${invalid}`));
  }
  const cwd = opts.cwd ? expandTilde(opts.cwd) : undefined;
  if (cwd && isSensitivePath(cwd)) return Promise.resolve(fail(`cwd blocked (sensitive): ${cwd}`));
  const maxLines = clampLines(opts.maxLines);
  const maxChars = clampChars(opts.maxChars);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ExecResult>((resolvePromise) => {
    const procs = norm.map((s) => spawn(s.command, s.args, { cwd, stdio: ["pipe", "pipe", "pipe"] }));
    let settled = false;
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let spawnError: string | undefined;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const finish = (timedOut: boolean, code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
      const out = clip(Buffer.concat(outChunks).toString("utf8"), maxLines, maxChars);
      const truncated = out.clipped || overflow;
      resolvePromise({
        ok: !spawnError && !timedOut,
        exitCode: code,
        stdout: out.text,
        stderr: clip(Buffer.concat(errChunks).toString("utf8"), 40, 2_000).text,
        truncated,
        totalLines: out.totalLines,
        hint: truncated ? `Showing ${Math.min(maxLines, out.totalLines)} of ${out.totalLines} lines. ${TRUNCATE_HINT}` : undefined,
        error: spawnError ?? (timedOut ? `timed out after ${timeoutMs}ms` : undefined),
      });
    };
    const timer = setTimeout(() => finish(true, null), timeoutMs);

    // Wire stage i stdout → stage i+1 stdin; swallow EPIPE from early-closing sinks.
    for (let i = 0; i < procs.length - 1; i++) {
      procs[i].stdout?.on("error", () => {});
      procs[i + 1].stdin?.on("error", () => {});
      procs[i].stdout?.pipe(procs[i + 1].stdin!);
    }
    procs[0].stdin?.on("error", () => {});
    procs[0].stdin?.end(); // first stage gets no external input

    const last = procs[procs.length - 1];
    last.stdout?.on("data", (c: Buffer) => {
      if (overflow) return;
      outBytes += c.length;
      if (outBytes > OUTPUT_CAP) { overflow = true; finish(false, null); return; }
      outChunks.push(c);
    });
    for (const p of procs) {
      p.stderr?.on("data", (c: Buffer) => { if (errBytes < 8_000) { errBytes += c.length; errChunks.push(c); } });
      p.on("error", (e: Error) => { spawnError ??= e.message; finish(false, null); });
    }
    last.on("close", (code) => finish(false, code));
  });
}
