// apps/mail-promoter/src/prefilter.ts
const NOISE_ROLES = new Set(["junk", "spam", "bulk"]);
const NOISE_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer|newsletter|bounce|postmaster)\b/i;

const OTP_EXPLICIT = /\bOTP\b|\bone[-\s]?time\s+(?:password|code|pin)\b/i;
const OTP_KEYWORD = /\b(?:verification|one[-\s]?time|security|login|access|codice)\b/i;
const CODE_NUM = /\b\d{3,8}\b/;

function isOtpSubject(subject: string): boolean {
  if (OTP_EXPLICIT.test(subject)) return true;
  return OTP_KEYWORD.test(subject) && CODE_NUM.test(subject);
}

/** Deterministic noise drop using only what the mirror stores. true = worth classifying. */
export function shouldConsider(msg: { fromAddr: string; subject: string; bodyState: string }, role?: string): boolean {
  if (role && NOISE_ROLES.has(role)) return false;
  if (msg.bodyState === "none") return false;
  const local = (msg.fromAddr || "").split("@")[0] ?? "";
  if (NOISE_SENDER.test(local)) return false;
  if (isOtpSubject(msg.subject || "")) return false;
  return true;
}
