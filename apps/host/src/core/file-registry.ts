/**
 * Maps opaque tokens to on-disk file paths so the host can serve tool-produced
 * files over HTTP (`/file/<token>`) without ever exposing arbitrary paths: only
 * files explicitly registered here (because a tool returned them) are reachable.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ChannelFile } from "@llm-wiki/protocol";

/** Paths never exposed for serving/opening, even if a card references them. */
const SENSITIVE = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.gnupg(\/|$)/,
  /\/Library\/Keychains(\/|$)/, /(^|\/)\.netrc$/, /(^|\/)Cookies(\/|$)/,
  /id_rsa/, /id_ed25519/, /(^|\/)\.env(\.[\w-]+)?$/, /credentials/i, /\.pem$/, /\.p12$/,
];
const isSensitivePath = (p: string): boolean => SENSITIVE.some((re) => re.test(p));

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".heic": "image/heic",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".html": "text/html", ".xml": "application/xml", ".zip": "application/zip", ".ics": "text/calendar",
  ".eml": "message/rfc822", ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const mimeFor = (path: string): string => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

const byPath = new Map<string, { ref: ChannelFile; path: string }>();
const byToken = new Map<string, { ref: ChannelFile; path: string }>();

/**
 * Register an on-disk file for serving. Returns its ref, or null if it isn't a
 * readable file. Refuses sensitive paths (SSH keys, .env, keychains, …) unless
 * `trusted` is set — only `saveUpload` may pass that, since it controls the
 * upload directory a file is written into.
 */
export function registerFile(path: string, opts: { trusted?: boolean } = {}): ChannelFile | null {
  try {
    if (!opts.trusted && isSensitivePath(path)) return null;
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile()) return null;
    const existing = byPath.get(path);
    if (existing) return existing.ref;
    const ref: ChannelFile = { name: basename(path), token: randomUUID(), mime: mimeFor(path), size: st.size, path };
    const entry = { ref, path };
    byPath.set(path, entry);
    byToken.set(ref.token, entry);
    return ref;
  } catch {
    return null;
  }
}

/** Resolve a token to its { path, ref }, or null if unknown. */
export function resolveToken(token: string): { ref: ChannelFile; path: string } | null {
  return byToken.get(token) ?? null;
}

/**
 * Register a path the UI wants to make actionable (e.g. a file card the agent
 * emitted). Expands a leading `~/`, refuses sensitive paths, and only registers
 * real files. This is how a card becomes openable without the path having to
 * come through a tool's output.
 */
export function registerUserPath(path: string): ChannelFile | null {
  const abs = path.startsWith("~/") || path === "~" ? path.replace(/^~/, homedir()) : path;
  if (!abs.startsWith("/")) return null;
  return registerFile(abs);
}

/**
 * Persist an uploaded file (bytes from the browser) to disk under a unique
 * folder that preserves its original filename (Mail attaches by filename), then
 * register it. Returns the ref, or null on failure.
 */
export function saveUpload(name: string, bytes: Buffer): ChannelFile | null {
  try {
    const uploadRoot = process.env.UPLOAD_DIR ?? join(homedir(), "Library", "Application Support", "llmwiki-uploads");
    const safe = basename(name || "file").replace(/[/\\]/g, "_").trim() || "file";
    const dir = join(uploadRoot, randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, safe);
    writeFileSync(path, bytes);
    return registerFile(path, { trusted: true });
  } catch {
    return null;
  }
}

/**
 * Walk a tool's output and register every absolute path that points to a real
 * file (e.g. save_attachment's `{ path }`, or the lines of a `find …` listing),
 * returning the file refs so the UI can render them as openable/draggable chips.
 * Multi-line strings are scanned line-by-line; capped so a big listing or a
 * file's contents can't register unbounded work.
 */
const MAX_REGISTERED = 100;

export function filesFromOutput(output: unknown): ChannelFile[] {
  const refs: ChannelFile[] = [];
  const seen = new Set<string>();
  const tryRegister = (candidate: string): void => {
    const p = candidate.trim();
    if (!p.startsWith("/") || seen.has(p) || refs.length >= MAX_REGISTERED) return;
    seen.add(p);
    const ref = registerFile(p);
    if (ref) refs.push(ref);
  };
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.includes("\n")) { for (const line of v.split("\n")) tryRegister(line); }
      else tryRegister(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(output);
  return refs;
}
