// apps/mail-promoter/src/prefilter.ts
const NOISE_ROLES = new Set(["junk", "spam", "bulk"]);
const NOISE_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer|newsletter|bounce|postmaster)\b/i;
const OTP_SUBJECT = /\b(verification|one[-\s]?time|security|login|access)\s+code\b|\bOTP\b|\bcodice\b|\b\d{4,8}\s+is your\b|\bis your.*code\b/i;

/** Deterministic noise drop using only what the mirror stores. true = worth classifying. */
export function shouldConsider(msg: { fromAddr: string; subject: string; bodyState: string }, role?: string): boolean {
  if (role && NOISE_ROLES.has(role)) return false;
  if (msg.bodyState === "none") return false;
  const local = (msg.fromAddr || "").split("@")[0] ?? "";
  if (NOISE_SENDER.test(local)) return false;
  if (OTP_SUBJECT.test(msg.subject || "")) return false;
  return true;
}
