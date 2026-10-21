// Compatibility entry point: the audit now compares MIME alternatives and
// extractor versions instead of searching for known placeholder phrases.
if (process.argv.includes("--apply")) {
  throw new Error("First run the audit, then apply its versioned plan with --apply-plan=PATH. Legacy HTML repair plans cannot establish MIME source provenance.");
}
if (!process.argv.some(arg=>/^--(?:reference|apply-plan)=/.test(arg))) process.argv.push("--pending");
await import("./eval-mail-body.mts");
