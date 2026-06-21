/** Apple stores labels like `_$!<Home>!$_`; unwrap to `Home`. Empty -> null. */
export function cleanLabel(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/^_\$!<(.+?)>!\$_$/);
  const out = (m ? m[1] : raw).trim();
  return out === "" ? null : out;
}
