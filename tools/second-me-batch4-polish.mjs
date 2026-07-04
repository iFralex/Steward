#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/alessioantonucci/Second Me";
const TODAY = "2026-07-04";

function edit(rel, fn) {
  const full = path.join(ROOT, rel);
  const before = fs.readFileSync(full, "utf8");
  let after = before.replace(/^updated: .+$/m, `updated: ${TODAY}`);
  after = fn(after);
  fs.writeFileSync(full, after);
}

edit("wiki/experiences/customer-solutions-engineer-google-application.md", (text) =>
  text
    .replace(
      "This application is distinct from the earlier [[google-step-internship-application]] and [[google-application-multichance-2026]], which targeted a STEP role.",
      "This prepared application package is distinct from the earlier [[google-step-internship-application]] and [[google-application-multichance-2026]], which targeted a STEP role.",
    )
    .replace(
      "- [[google]] – Third distinct application targeting Google (after STEP and Multichance).",
      "- [[google]] – Distinct prepared application package targeting Google, separate from STEP and Multichance traces.",
    ),
);

edit("wiki/projects/candidai-project.md", (text) =>
  text
    .replace(
      "- [[candidai-promo-video-commission]] – A 30‑second promo video commissioned from [[john-odunayo]] (VFX designer) with a $400 budget ([[mail-thread-2648]]). The commission appears stalled / unresolved as of the last communication; no payment has been made.",
      "- [[candidai-promo-video-commission]] – A 30-second promo video commissioned from [[john-odunayo]] (VFX designer) with a $400 budget ([[mail-thread-2648]]). Alessio paid $200 upfront; no delivery or reply followed after 6 January 2026, so the track is closed as stalled/no response.",
    )
    .replace(
      "- Promo video budget: $400 (unpaid / not completed).",
      "- Promo video budget: $400 total; $200 upfront paid, no final delivery documented.",
    )
    .replace(
      "| 2026 (undated) | Promo video commission with John Odunayo (stalled) |",
      "| 2025-12 to 2026-01 | Promo video commission with John Odunayo; $200 upfront paid, no reply after 6 January 2026 |",
    ),
);

console.log("Polished batch 4 wording.");
