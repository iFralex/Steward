import { readFile } from "node:fs/promises";
import { simpleParser } from "mailparser";
import type { ParsedAttachment, ParsedMessage } from "./types.ts";

export function normalizeId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/^<|>$/g, "").trim();
  return t.length ? t : null;
}

function normalizeRefs(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/\s+/);
  return list.map((r) => normalizeId(r)).filter((r): r is string => !!r);
}

/** Strip the leading byte-count line and the trailing plist; return the message bytes. */
export function sliceMessageBytes(buf: Buffer): Buffer {
  const nl = buf.indexOf(0x0a); // first newline
  if (nl < 0) return buf;
  const count = parseInt(buf.subarray(0, nl).toString("ascii"), 10);
  if (Number.isFinite(count) && count > 0 && nl + 1 + count <= buf.length) {
    return buf.subarray(nl + 1, nl + 1 + count);
  }
  // Fallback: drop only the count line if the count looks wrong.
  return buf.subarray(nl + 1);
}

export async function parseEmlx(buf: Buffer): Promise<ParsedMessage> {
  const m = await simpleParser(sliceMessageBytes(buf));
  const fromAddr = m.from?.value?.[0]?.address ?? "";
  const fromName = m.from?.value?.[0]?.name ?? "";
  const toList = (m.to && !Array.isArray(m.to) ? m.to.value : []).map((a) => a.address ?? "").filter(Boolean);
  const ccList = (m.cc && !Array.isArray(m.cc) ? m.cc.value : []).map((a) => a.address ?? "").filter(Boolean);
  const bodyText = m.text ?? (m.html ? String(m.html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
  const attachments: ParsedAttachment[] = (m.attachments ?? []).map((a) => ({
    filename: a.filename ?? "attachment",
    mime: a.contentType ?? "application/octet-stream",
    size: a.size ?? a.content.length,
    content: a.content,
  }));
  const gm = m.headers.get("x-gm-thrid");
  return {
    messageId: normalizeId(m.messageId) ?? "",
    fromName,
    fromAddr,
    to: toList,
    cc: ccList,
    subject: m.subject ?? "",
    date: m.date ? Math.floor(m.date.getTime() / 1000) : 0,
    bodyText,
    inReplyTo: normalizeId(m.inReplyTo),
    references: normalizeRefs(m.references),
    gmThrid: gm ? String(gm) : null,
    attachments,
  };
}

export async function parseEmlxFile(path: string): Promise<ParsedMessage> {
  return parseEmlx(await readFile(path));
}
