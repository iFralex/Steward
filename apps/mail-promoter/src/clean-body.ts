/**
 * Heuristically clean an email body before sending it to an LLM: strip HTML,
 * cut quoted reply history and signatures, collapse tracking URLs to their
 * domain, drop boilerplate footers, and normalize whitespace. Cuts token cost
 * dramatically (real emails are mostly markup / URLs / quoted history) and
 * reduces noise so the model focuses on the actual message.
 */

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#39;/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Real HTML markup (avoid treating a plain-text "<email@x>" as HTML).
const HTML_TAG = /<(?:\/?)(?:p|div|br|a|span|table|td|tr|tbody|thead|html|body|head|img|ul|ol|li|h[1-6]|style|script|b|strong|em|i|u|font|center|blockquote|pre|hr|title|meta|link)\b[^>]*>/i;

function stripHtml(s: string): string {
  let t = s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(t);
}

// Markers that begin quoted reply history; everything from the earliest is dropped.
const CUT_MARKERS: RegExp[] = [
  /(^|\n)>/,                                   // a quoted line
  /\n?On\b[\s\S]{0,120}?\bwrote:/i,            // "On <date>, X wrote:"
  /\n?Il giorno\b[\s\S]{0,160}?\bha scritto:/i, // Italian "Il giorno ... ha scritto:"
  /\n-{3,}\s*Original Message\s*-{3,}/i,
  /\n_{5,}/,                                    // Outlook header rule
  /\nDa:\s[\s\S]{0,200}?\nInviato:/i,          // Italian Outlook header block
  /\nFrom:\s[\s\S]{0,200}?\nSent:/i,
  /\n-- ?\r?\n/,                                // standard signature delimiter
];

function cutHistoryAndSignature(s: string): string {
  let cut = s.length;
  for (const re of CUT_MARKERS) {
    const m = re.exec(s);
    if (m && m.index < cut) cut = m.index;
  }
  return s.slice(0, cut);
}

// Redirector / tracker hosts whose URLs carry no useful destination.
const TRACKER_HOST = /^(t\.co|lnkd\.in|click\.|clicks?\.|email\.|e\.|link\.|track\.|trk\.|mailchi|list-manage|sendgrid|sg\.|cmail|juiceadv|piumail)/i;
// Path/query fragments that mark a tracking redirect rather than real content.
const TRACKER_PATH = /\b(track|campaign|click|redirect|aff_c|crm)\b/i;
const TRACKING_QS = /utm_|fbclid|gclid|mc_eid|correlation_id|hash=|token=|\bsig=/i;

/**
 * Keep a link's useful destination (scheme+host+path) but drop tracking noise:
 * known tracker hosts and tracking paths collapse to `[domain]`; query strings
 * are dropped unless short and clean; anything still very long -> `[domain]`.
 */
function collapseUrls(s: string): string {
  return s.replace(/https?:\/\/([^\s/?#]+)([^\s?#]*)(\?[^\s#]*)?(#\S*)?/gi, (_full, hostRaw, path = "", query = "") => {
    const host = String(hostRaw).replace(/^www\./i, "");
    if (TRACKER_HOST.test(host) || TRACKER_PATH.test(path)) return `[${host}]`;
    let kept = `https://${host}${path}`;
    const q = String(query || "");
    if (q && q.length <= 32 && !TRACKING_QS.test(q)) kept += q; // keep a short, clean query (e.g. ?v=abc123)
    return kept.length > 120 ? `[${host}]` : kept;
  });
}

const BOILERPLATE = /unsubscrib|disiscriv|annullare l'iscrizione|annulla l'iscrizione|cancellati|sent from my |inviato da |view (this email )?in (your )?browser|visualizza nel browser|update your preferences|gestisci le preferenze/i;

function dropBoilerplate(s: string): string {
  return s
    .split("\n")
    .filter((line) => !BOILERPLATE.test(line))
    .join("\n");
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanBody(raw: string): string {
  if (!raw) return "";
  let t = raw;
  if (HTML_TAG.test(t)) t = stripHtml(t);
  t = cutHistoryAndSignature(t);
  t = collapseUrls(t);
  t = dropBoilerplate(t);
  return normalizeWhitespace(t);
}
