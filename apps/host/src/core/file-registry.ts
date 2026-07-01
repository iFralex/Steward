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

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(homedir(), "Library", "Application Support", "llmwiki-uploads");

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

/** Register an on-disk file for serving. Returns its ref, or null if it isn't a readable file. */
export function registerFile(path: string): ChannelFile | null {
  try {
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
 * Persist an uploaded file (bytes from the browser) to disk under a unique
 * folder that preserves its original filename (Mail attaches by filename), then
 * register it. Returns the ref, or null on failure.
 */
export function saveUpload(name: string, bytes: Buffer): ChannelFile | null {
  try {
    const safe = basename(name || "file").replace(/[/\\]/g, "_").trim() || "file";
    const dir = join(UPLOAD_DIR, randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, safe);
    writeFileSync(path, bytes);
    return registerFile(path);
  } catch {
    return null;
  }
}

/**
 * Walk a tool's output and register every absolute path that points to a real
 * file (e.g. save_attachment's `{ path }`), returning the file refs.
 */
export function filesFromOutput(output: unknown): ChannelFile[] {
  const refs: ChannelFile[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.startsWith("/") && !seen.has(v)) {
        seen.add(v);
        const ref = registerFile(v);
        if (ref) refs.push(ref);
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(output);
  return refs;
}
