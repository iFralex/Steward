import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { AttachmentRow, Store } from "../../mail-mirror/src/store.ts";

const INGESTABLE_EXTENSIONS = new Set([
  "md", "mdx", "txt", "pdf", "doc", "docx", "pptx", "xls", "xlsx",
  "odt", "odp", "ods", "rtf", "html", "htm", "csv",
]);

const MIME_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/rtf": "rtf",
  "text/html": "html",
};

export interface PromotedAttachment {
  filename: string;
  relativePath: string;
  mime: string;
  size: number;
  sha256: string;
}

export interface AttachmentSyncResult {
  attachments: PromotedAttachment[];
  copied: number;
  alreadyPresent: number;
  skipped: number;
}

export function attachmentDecisionId(row: AttachmentRow): string {
  const safe = basename(row.filename)
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 48) || "attachment";
  return `${row.sha256.slice(0, 16)}-${safe}`;
}

export function categoryForAttachment(filename: string): "cv" | "lettere" | "documenti" {
  const name = filename.normalize("NFKC").toLowerCase();
  if (/\b(cv|curriculum|resume|résumé)\b/.test(name)) return "cv";
  if (/(cover[\s_-]*letter|motivation|motivaz|reference[\s_-]*letter|recommendation[\s_-]*letter)/.test(name)) {
    return "lettere";
  }
  return "documenti";
}

function cleanFilename(filename: string, fallbackExtension: string): string {
  const original = basename(filename).normalize("NFKC");
  const extension = extname(original).slice(1).toLowerCase() || fallbackExtension;
  const stem = (extension ? original.slice(0, -(extension.length + 1)) : original)
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80) || "attachment";
  return extension ? `${stem}.${extension}` : stem;
}

function extensionFor(row: AttachmentRow): string {
  return extname(row.filename).slice(1).toLowerCase()
    || MIME_EXTENSION[row.mime.toLowerCase()]
    || "";
}

function sourcePathFor(root: string, blobPath: string): string | null {
  if (!blobPath) return null;
  const base = resolve(root);
  const candidate = resolve(base, blobPath);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) return null;
  return candidate;
}

export function syncThreadAttachments(args: {
  store: Store;
  threadId: number;
  blobRoot: string;
  sourcesDir: string;
  maxBytes?: number;
  includeIds?: Iterable<string>;
}): AttachmentSyncResult {
  const maxBytes = args.maxBytes ?? 100 * 1024 * 1024;
  const includeIds = args.includeIds ? new Set(args.includeIds) : null;
  const seen = new Set<string>();
  const result: AttachmentSyncResult = { attachments: [], copied: 0, alreadyPresent: 0, skipped: 0 };

  for (const row of args.store.attachmentsForThread(args.threadId)) {
    if (includeIds && !includeIds.has(attachmentDecisionId(row))) continue;
    if (seen.has(row.sha256)) continue;
    seen.add(row.sha256);
    const extension = extensionFor(row);
    const source = sourcePathFor(args.blobRoot, row.blobPath);
    if (!row.downloaded || !source || !existsSync(source) || !INGESTABLE_EXTENSIONS.has(extension)) {
      result.skipped++;
      continue;
    }
    const size = statSync(source).size;
    if (size < 32 || size > maxBytes) {
      result.skipped++;
      continue;
    }

    const category = categoryForAttachment(row.filename);
    const destinationDir = join(args.sourcesDir, category);
    mkdirSync(destinationDir, { recursive: true });
    const safeName = cleanFilename(row.filename, extension);
    const filename = `${row.sha256.slice(0, 16)}-${safeName}`;
    const destination = join(destinationDir, filename);
    if (existsSync(destination)) {
      result.alreadyPresent++;
    } else {
      const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
      try {
        copyFileSync(source, temp);
        renameSync(temp, destination);
      } catch (err) {
        try { unlinkSync(temp); } catch { /* best effort */ }
        throw err;
      }
      result.copied++;
    }
    result.attachments.push({
      filename: row.filename,
      relativePath: relative(args.sourcesDir, destination).split(sep).join("/"),
      mime: row.mime,
      size,
      sha256: row.sha256,
    });
  }

  return result;
}
