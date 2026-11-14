import { convert } from "html-to-text";
import { Parser } from "htmlparser2";
import { createHash } from "node:crypto";

import { BODY_EXTRACTOR_VERSION } from "./body-version.ts";
export { BODY_EXTRACTOR_VERSION } from "./body-version.ts";
export interface BodyExtraction {
  version: number;
  source: "plain" | "html" | "both" | "none";
  quality: "usable" | "ambiguous" | "limited" | "unavailable";
  reason: string;
  issues: string[];
  plainChars: number;
  htmlChars: number;
  /** Diagnostic overlap only; never proof of factual equivalence. */
  coverage?: { plainInHtml: number; htmlInPlain: number };
  sourceHash?: string;
  textHash?: string;
  textBytes?: number;
  alternatives?: { source: "plain" | "html"; offset: number; chars: number }[];
}
export interface BodyResult { text: string; extraction: BodyExtraction }
export interface BodyLimits { inputChars: number; outputChars: number; nodes: number; depth: number }
const LIMITS: BodyLimits = { inputChars: 32 * 1024 * 1024, outputChars: 1024 * 1024, nodes: 100_000, depth: 128 };
const SKIP = new Set(["head", "script", "style", "template", "noscript", "iframe", "object"]);
const TAGS = new Set("p div section article br hr table thead tbody tfoot tr td th caption blockquote pre code ul ol li dl dt dd a b strong i em h1 h2 h3 h4 h5 h6".split(" "));
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Recognize actual documents and fragments, not a mention of HTML in mail prose. */
export function looksLikeHtml(text: string): boolean {
  const start = text.trimStart().slice(0, 2048);
  return /^(?:<!doctype\s+html\b|<(?:html|body|head)\b)/i.test(start)
    || (/^<(?:p|div|table|section|article|ul|ol|blockquote)\b/i.test(start)
      && /<\/(?:p|div|table|section|article|ul|ol|blockquote)>/i.test(text));
}
export function extractionIsCurrent(text: string, extraction?: BodyExtraction): boolean {
  return !!extraction && extraction.version >= BODY_EXTRACTOR_VERSION
    && extraction.textHash === createHash("sha256").update(text).digest("hex");
}

/** Offsets let a paginated reader jump straight to either retained alternative. */
export function alternativeRanges(body: string, extraction: BodyExtraction): BodyExtraction["alternatives"] {
  if (extraction.source !== "both") return undefined;
  const firstLabel = body.indexOf("\n\n[Versione ");
  if (firstLabel < 0) return undefined;
  const htmlFirst = body.startsWith("\n\n[Versione HTML]\n", firstLabel);
  const first: "plain" | "html" = htmlFirst ? "html" : "plain";
  const second: "plain" | "html" = htmlFirst ? "plain" : "html";
  const label = (source: "plain" | "html") => source === "html" ? "[Versione HTML]\n" : "[Versione testuale]\n";
  const length = (source: "plain" | "html") => source === "html" ? extraction.htmlChars : extraction.plainChars;
  const offset = firstLabel + 2 + label(first).length;
  const secondLabel = offset + length(first) + 2;
  if (!body.startsWith(label(second), secondLabel)) return undefined;
  return [{source:first,offset,chars:length(first)}, {source:second,offset:secondLabel+label(second).length,chars:length(second)}];
}

function renderHtml(source: string, limits: BodyLimits) {
  const issues: string[] = [];
  if (source.length > limits.inputChars) return { text: "", core: "", issues: ["html-input-limit"], images: 0, visibleChars: 0 };
  const full: string[] = [], core: string[] = [];
  const stack: { name: string; outputName: string; hidden: boolean; accessory: boolean; emitted: boolean }[] = [];
  let nodes = 0, chars = 0, images = 0, visibleChars = 0, stopped = false;
  const stop = (issue: string) => { issues.push(issue); stopped = true; parser.pause(); };
  const emit = (value: string, accessory: boolean) => {
    if (stopped) return;
    if (chars + value.length > limits.outputChars) { stop("html-output-limit"); return; }
    chars += value.length; full.push(value);
    if (!accessory) core.push(value);
  };
  const parser = new Parser({
    onopentag(name, attrs) {
      if (stopped) return;
      if (++nodes > limits.nodes) { stop("html-node-limit"); return; }
      if (stack.length >= limits.depth) { stop("html-depth-limit"); return; }
      const parent = stack.at(-1);
      const hidden = !!parent?.hidden || SKIP.has(name) || "hidden" in attrs
        || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i.test(attrs.style ?? "");
      const accessory = !!parent?.accessory || ["footer", "nav", "blockquote"].includes(name)
        || ["contentinfo", "navigation"].includes(attrs.role ?? "");
      // SVG chart labels and descriptions are text too. Drop executable content,
      // not the entire SVG: no drawing instructions or event attributes are emitted.
      const outputName = ["text", "title", "desc"].includes(name) && stack.some(frame=>frame.name==="svg") ? "p" : name;
      const emitted = !hidden && TAGS.has(outputName);
      stack.push({ name, outputName, hidden, accessory, emitted });
      if (hidden) { if (!parent?.hidden && !SKIP.has(name)) issues.push("hidden-content"); return; }
      if (name === "img") {
        const small = (Number(attrs.width) > 0 && Number(attrs.width) <= 2) || (Number(attrs.height) > 0 && Number(attrs.height) <= 2);
        if (small || attrs.role === "presentation" || attrs["aria-hidden"] === "true") return;
        images++;
        // Alt describes the image; it is not extracted image content.
        emit(escape(attrs.alt?.trim() ? `[Immagine: ${attrs.alt.trim()}]` : "[Immagine]"), accessory);
      }
      if (name === "pre" || name === "code") issues.push("preformatted-content");
      if (!emitted) return;
      let attributes = "";
      if (name === "a" && attrs.href && /^(?:https?:|mailto:|tel:)/i.test(attrs.href)) {
        if (attrs.href.length <= 16_384) attributes = ` href="${escape(attrs.href)}"`;
        else issues.push("link-length-limit");
      }
      if (name === "table" && attrs.role === "table") attributes = ' data-mail-table="true"';
      emit(`<${outputName}${attributes}>`, accessory);
    },
    ontext(text) {
      const frame = stack.at(-1);
      if (frame?.name === "style" && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(text)) issues.push("stylesheet-visibility-unresolved");
      if (stopped || frame?.hidden) return;
      visibleChars += text.replace(/\s/g, "").length;
      emit(escape(text), !!frame?.accessory);
    },
    onclosetag() {
      const frame = stack.pop();
      if (frame?.emitted && !["br", "hr"].includes(frame.name)) emit(`</${frame.outputName}>`, frame.accessory);
    },
  }, { decodeEntities: true });
  parser.end(source);
  const options = {
    wordwrap: false as const,
    limits: { maxInputLength: undefined, maxDepth: limits.depth + 1 },
    selectors: [
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map(selector=>({selector,options:{uppercase:false}})),
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'table[data-mail-table="true"]', format: "dataTable", options: { uppercaseHeaderCells: false } },
    ],
  };
  return { text: convert(full.join(""), options).trim(), core: convert(core.join(""), options).trim(), issues: [...new Set(issues)], images, visibleChars };
}

function withoutUrls(text: string): string {
  return text.replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s<>\]]+/g, "").replace(/\[\s*\]/g, "");
}
function normalized(text: string): string {
  return withoutUrls(text).replace(/\[cid:[^\]]+\]/gi, "").replace(/\[Immagine\]/g, "")
    .replace(/<\s*>/g, "").normalize("NFC").replace(/\s+/gu, " ").trim();
}
function blocks(text: string): string[] { return text.split(/\n\s*\n/).map(normalized).filter(Boolean); }
function links(text: string): Set<string> { return new Set(text.match(/https?:\/\/[^\s<>\])]+/g) ?? []); }
function containsAll(a: Set<string>, b: Set<string>): boolean { return [...b].every(value => a.has(value)); }
function coversBlocks(haystack: string[], needle: string[]): boolean {
  let at = 0;
  for (const block of haystack) if (at < needle.length && block === needle[at]) at++;
  return at === needle.length;
}
function shingles(text: string): Set<string> {
  const chars = [...normalized(text).toLowerCase()];
  const result = new Set<string>();
  for (let i = 0; i <= chars.length - 5; i++) result.add(chars.slice(i, i + 5).join(""));
  if (chars.length && chars.length < 5) result.add(chars.join(""));
  return result;
}
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size) return 0;
  let count = 0; for (const value of a) if (b.has(value)) count++;
  return Math.round(count / a.size * 1000) / 1000;
}

/** No sender, language dictionary, embedding model or placeholder phrase is consulted. */
export function extractBody(text: string | undefined, html: string | false | undefined, customLimits: Partial<BodyLimits> = {}): BodyResult {
  const limits = { ...LIMITS, ...customLimits };
  const original = text ?? "";
  const markup = looksLikeHtml(original);
  const plain = markup ? "" : original.trim();
  const rendered = renderHtml(html || (markup ? original : ""), limits);
  const extraction: BodyExtraction = {
    version: BODY_EXTRACTOR_VERSION, source: "none", quality: "unavailable", reason: "no-readable-content",
    issues: rendered.issues, plainChars: plain.length, htmlChars: rendered.text.length,
  };
  const result = (body: string, source: BodyExtraction["source"], quality: BodyExtraction["quality"], reason: string): BodyResult => {
    extraction.source = source; extraction.quality = quality; extraction.reason = reason;
    const ranges = alternativeRanges(body, extraction);
    if (ranges) extraction.alternatives = ranges;
    if (extraction.issues.some(issue => issue.endsWith("-limit") || issue === "image-content-not-extracted")) extraction.quality = "limited";
    if (body.length > limits.outputChars) {
      body = body.slice(0, limits.outputChars) + "\n\n[Estrazione incompleta: limite di dimensione raggiunto.]";
      extraction.issues.push("body-output-limit"); extraction.quality = "limited";
      if (extraction.alternatives) for (const range of extraction.alternatives) range.chars = Math.max(0, Math.min(range.chars, limits.outputChars-range.offset));
    }
    extraction.textHash = createHash("sha256").update(body).digest("hex");
    extraction.textBytes = Buffer.byteLength(body);
    return { text: body, extraction };
  };
  if (original.length > limits.inputChars && !markup) {
    extraction.issues.push("plain-input-limit");
    return result(plain, "plain", "limited", "plain-input-limit");
  }
  if (rendered.images && rendered.visibleChars < 20) {
    extraction.issues.push("image-content-not-extracted");
    if (!plain) return result(rendered.text, "html", "limited", "image-only");
  }
  if (!rendered.text) return result(plain, plain ? "plain" : "none", plain ? "usable" : "unavailable", plain ? "plain-only" : "no-readable-content");
  if (!plain) return result(rendered.text, "html", "usable", markup ? "mislabeled-html" : "html-only");

  if (plain.length > 100_000 || rendered.text.length > 100_000) {
    extraction.issues.push("comparison-limit");
    return result(`[Le versioni HTML e testuale sono conservate separatamente.]\n\n[Versione HTML]\n${rendered.text}\n\n[Versione testuale]\n${plain}`, "both", "limited", "comparison-limit");
  }
  const p = normalized(plain), h = normalized(rendered.text);
  const pShingles = shingles(plain), hShingles = shingles(rendered.core);
  extraction.coverage = { plainInHtml: overlap(pShingles, hShingles), htmlInPlain: overlap(hShingles, pShingles) };
  const plainLinks = links(plain), htmlLinks = links(rendered.text);
  // Only exact block coverage suppresses an alternative. Similarity alone must
  // not erase a changed amount, code, negation, sentence order or date.
  const pBlocks = blocks(plain), hBlocks = blocks(rendered.text);
  const preformattedDifference = extraction.issues.includes("preformatted-content") && plain !== rendered.text;
  const coversPlain = !preformattedDifference && (p === h || coversBlocks(hBlocks, pBlocks));
  const coversHtml = !preformattedDifference && (p === h || coversBlocks(pBlocks, hBlocks));
  if (coversPlain && containsAll(htmlLinks, plainLinks)) {
    if (coversHtml && containsAll(plainLinks, htmlLinks)) return result(plain, "plain", "usable", "equivalent-alternatives");
    return result(rendered.text, "html", "usable", "html-covers-plain");
  }
  if (coversHtml && containsAll(plainLinks, htmlLinks)) return result(plain, "plain", "usable", "plain-covers-html");

  // A short plain part could be a valid message OR an unknown placeholder.
  // Choose a reading order without discarding either original representation.
  const htmlFirst = normalized(rendered.core).length >= p.length;
  const first = htmlFirst ? `[Versione HTML]\n${rendered.text}` : `[Versione testuale]\n${plain}`;
  const second = htmlFirst ? `[Versione testuale]\n${plain}` : `[Versione HTML]\n${rendered.text}`;
  return result(`[Le versioni HTML e testuale differiscono; sono riportate entrambe.]\n\n${first}\n\n${second}`, "both", "ambiguous", "different-alternatives");
}

export async function readableBody(text: string | undefined, html: string | false | undefined): Promise<string> {
  return extractBody(text, html).text;
}
