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

const FLAG_READ = 0x1;
const FLAG_ANSWERED = 0x4;
const FLAG_FLAGGED = 0x10;
const FLAG_JUNK = 0x1000000;

/** Decode the low 32 bits of the .emlx plist `flags` bitfield. Bits validated on real mail. */
export function decodeFlags(flags: number): { read: boolean; answered: boolean; flagged: boolean; junk: boolean } {
  const lo = flags >>> 0; // keep low 32 bits as unsigned; the flags we read live there
  return {
    read: !!(lo & FLAG_READ),
    answered: !!(lo & FLAG_ANSWERED),
    flagged: !!(lo & FLAG_FLAGGED),
    junk: !!(lo & FLAG_JUNK),
  };
}

function plistInt(xml: string, key: string): number | null {
  const m = new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`).exec(xml);
  return m ? Number(m[1]) : null;
}

/** Read the trailing Apple plist of an .emlx buffer; returns nulls when absent. */
export function parsePlistTrailer(buf: Buffer): { flags: number | null; color: number | null; appleThrid: number | null } {
  const s = buf.toString("utf8");
  const start = s.indexOf("<plist");
  if (start < 0) return { flags: null, color: null, appleThrid: null };
  const xml = s.slice(start);
  return { flags: plistInt(xml, "flags"), color: plistInt(xml, "color"), appleThrid: plistInt(xml, "conversation-id") };
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
  const trailer = parsePlistTrailer(buf);
  const fromAddr = m.from?.value?.[0]?.address ?? "";
  const fromName = m.from?.value?.[0]?.name ?? "";
  const addrs = (v: typeof m.to) =>
    (Array.isArray(v) ? v : v ? [v] : []).flatMap((g) => g.value).map((a) => a.address ?? "").filter(Boolean);
  const toList = addrs(m.to);
  const ccList = addrs(m.cc);
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
    gmThrid: typeof gm === "string" ? gm : null,
    flags: trailer.flags != null ? decodeFlags(trailer.flags) : null,
    flagColor: trailer.color,
    appleThrid: trailer.appleThrid,
    attachments,
  };
}

export async function parseEmlxFile(path: string): Promise<ParsedMessage> {
  return parseEmlx(await readFile(path));
}
