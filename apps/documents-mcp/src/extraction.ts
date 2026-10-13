import { cachedDocument, cacheDocument } from "./cache.ts";
import { ARCHIVE_DOCUMENT_EXTENSIONS, resolveSafeDocument, TEXT_EXTENSIONS } from "./security.ts";
import type { DocumentHeading, ExtractedDocument } from "./types.ts";
import { readTextDocument } from "./readers/text.ts";
import { readPdfDocument } from "./readers/pdf.ts";
import { readDocx, readOdt, readPptx, readRtf } from "./readers/office.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_WARNINGS = 10;
const MAX_WARNING_CHARS = 300;

export async function extractDocument(inputPath: string): Promise<ExtractedDocument> {
  const safe = resolveSafeDocument(inputPath);
  const cached = cachedDocument(safe.cacheKey);
  if (cached) return cached;
  const extracted = await withTimeout(extractByType(safe.path, safe.extension), extractionTimeout(), "document extraction timed out");
  return cacheDocument({
    ...safe,
    format: safe.extension.slice(1),
    pages: extracted.pages,
    headings: "headings" in extracted ? extracted.headings as DocumentHeading[] : [],
    warnings: extracted.warnings.slice(0, MAX_WARNINGS).map((warning) => warning.slice(0, MAX_WARNING_CHARS)),
  });
}

async function extractByType(path: string, extension: string) {
  if (TEXT_EXTENSIONS.has(extension)) return readTextDocument(path, extension);
  if (extension === ".pdf") return readPdfDocument(path);
  if (extension === ".rtf") return readRtf(path);
  if (ARCHIVE_DOCUMENT_EXTENSIONS.has(extension)) {
    if (extension === ".docx") return readDocx(path);
    if (extension === ".pptx") return readPptx(path);
    return readOdt(path);
  }
  throw new Error(`unsupported document type '${extension}'`);
}

function extractionTimeout(): number {
  const configured = Number(process.env.DOCUMENT_EXTRACT_TIMEOUT_MS);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1_000), 60_000) : DEFAULT_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
