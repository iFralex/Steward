import fs from "node:fs";
import path from "node:path";

const root = "/Users/alessioantonucci/Second Me";
const reviewPath = path.join(root, ".llm-wiki", "review.json");
const today = "2026-07-04";

function file(rel) {
  return path.join(root, rel);
}

function read(rel) {
  return fs.readFileSync(file(rel), "utf8");
}

function write(rel, text) {
  fs.writeFileSync(file(rel), text);
}

function replace(rel, pairs) {
  let text = read(rel);
  const before = text;
  for (const [from, to] of pairs) text = text.replace(from, to);
  if (text !== before) write(rel, text);
  return text !== before ? 1 : 0;
}

function ensure(rel, marker, block) {
  const text = read(rel);
  if (text.includes(marker)) return 0;
  write(rel, `${text.replace(/\s*$/, "")}\n\n${block.trim()}\n`);
  return 1;
}

let changed = 0;

// Bebe repository and identity.
changed += replace("wiki/projects/bebe-project.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/status: uncertain/, "status: historical"],
  [/"Bebe" is a GitHub project developed by Alessio after pausing freelance game work in 2022\. Described in his Google cover letter as a project where he dedicated "a significant amount of time and effort to implementing new technologies\." The exact purpose, technologies used, and current status are not documented in the available sources\./, "\"Bebe\" is a GitHub project developed by Alessio after pausing freelance game work in 2022. The public repository is `https://github.com/iFralex/Bebe`. GitHub describes it as a C# 2D vertical platformer where players guide a bird through obstacle-filled environments with customization, berries, egg-based ratings, power-ups, and a heart system."],
  [/- The GitHub repository has not been located or linked in the sources\./, "- **GitHub repository:** `https://github.com/iFralex/Bebe`\n- **Repository created:** 2023-10-22\n- **Primary language:** C#\n- **Relation to [[bebe-video-game]]:** same broad game/project identity; the repository appears to be the public/code-side trace of the earlier Bebe game effort."],
]);
changed += ensure(
  "wiki/projects/bebe-project.md",
  "## Repository Resolution",
  `
## Repository Resolution

The repository is \`https://github.com/iFralex/Bebe\`. It was created on GitHub on 2023-10-22 and uses C#. This resolves the repository-location gap.
`
);

changed += replace("wiki/projects/bebe-video-game.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/status: uncertain/, "status: historical"],
]);
changed += ensure(
  "wiki/projects/bebe-video-game.md",
  "## Repository",
  `
## Repository

The public GitHub repository for Bebe is \`https://github.com/iFralex/Bebe\`. GitHub lists the repository as a C# project created on 2023-10-22. The repository description identifies Bebe as a 2D vertical platformer starring a bird character, aligning it with the game documented by the 2021-2022 graphics collaboration.
`
);

// CrispyByte metrics.
changed += replace("wiki/projects/crispybyte.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/These quantified metrics make CrispyByte the most impact‑demonstrated project in any source so far\. The numbers are self‑claimed and unattributed\. The 15% turnover figure is attributed specifically to Firebase‑powered personalisation in the April 2026 email\./, "These quantified metrics make CrispyByte the most impact-demonstrated project in the wiki. The figures reflect the historical project claim and are treated as true for the personal timeline, but the underlying restaurant/source data is no longer available, so the wiki cannot independently reconstruct the calculations. The 15% turnover figure is attributed specifically to Firebase-powered personalisation in the April 2026 email."],
]);
changed += ensure(
  "wiki/projects/crispybyte.md",
  "## Metrics Resolution",
  `
## Metrics Resolution

The 15% turnover increase and 28% loyalty boost should remain in the project narrative as historical CrispyByte metrics. The raw data behind those metrics is no longer available, so future summaries should avoid presenting them as independently auditable figures.
`
);

// CV 3 metadata.
changed += replace("wiki/sources/8-carriera--10-cv-storici--4-cv-3--16qkz8v.md", [
  [/title: "Historical CV 3 \(estimated late 2023\)"/, 'title: "Historical CV 3 (PDF export 2024-07-20)"'],
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/source_date: "2023-12"/, 'source_date: "2024-07-20"'],
  [/# Source: Historical CV 3 \(estimated late 2023\)/, "# Source: Historical CV 3 (PDF export 2024-07-20)"],
  [/This CV predates the \[\[dotdotdot\]\] and \[\[st-engineering-antycip\]\] roles and the \[\[candidai\]\] project\. It captures Alessio Antonucci's profile as a self-employed full‑stack developer and entrepreneur during late 2023\./, "This CV PDF was exported from Pages on 20 July 2024, according to the PDF metadata (`CreationDate` and `ModDate`). Its content still predates the [[dotdotdot]] and [[st-engineering-antycip]] roles and the [[candidai]] project, capturing Alessio Antonucci's profile as a self-employed full-stack developer and entrepreneur before those later roles."],
]);
changed += ensure(
  "wiki/sources/8-carriera--10-cv-storici--4-cv-3--16qkz8v.md",
  "## Metadata",
  `
## Metadata

The original PDF metadata reports:

- **Creator:** Pages
- **Producer:** macOS 14.5 Quartz PDFContext
- **CreationDate:** 2024-07-20 12:51:06 CEST
- **ModDate:** 2024-07-20 12:51:06 CEST

The filesystem creation date in the wiki folder reflects ingest/copy time, not the original CV date.
`
);

// Crypto / Terra Luna.
changed += replace("wiki/topics/passions-and-interests.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
]);
changed += ensure(
  "wiki/topics/passions-and-interests.md",
  "## Crypto and Financial Learning",
  `
## Crypto and Financial Learning

Crypto investing is part of Alessio's real financial-learning history, not just a cover-letter narrative. The most important episode was losing money in crypto, particularly around Terra/Luna. In the wiki this should be framed as a practical lesson in risk, speculation, and downside exposure rather than as a current investment thesis.
`
);

changed += ensure(
  "wiki/topics/personal-finance-accounts.md",
  "## Crypto Losses",
  `
## Crypto Losses

Alessio has real crypto-investing experience and lost money in crypto, particularly with Terra/Luna. This is relevant as a financial-learning episode and should be distinguished from his later ETF-focused Fineco setup.
`
);

// Game development course in fourth year of high school.
changed += replace("wiki/experiences/game-developer-freelance.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
]);
changed += ensure(
  "wiki/experiences/game-developer-freelance.md",
  "## Teaching Attempt in High School",
  `
## Teaching Attempt in High School

During the fourth year of high school, Alessio attempted to run or teach a video-game-development course at school. This really happened, but it is best recorded as a learning experience rather than a polished success: the later J.P. Morgan application frames it as a setback that taught lessons about teaching, management, and expectations.
`
);

// DotDotDot timeline reconciliation and reference handling.
changed += replace("wiki/organizations/dotdotdot.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/DotDotDot is a digital studio \(also referred to as a digital agency\) based in Milan, Italy \(Via Tertulliano 70, 20137 Milano\)\. \[\[alessio-antonucci\]\] had a documented relationship with the studio beginning in August 2024 and continuing through at least April 2026\. His roles evolved from a prospective placement to confirmed collaboration; the exact nature of the engagement \(employee vs\. contractor\) is not fully clarified by available sources\./, "DotDotDot is a digital studio (also referred to as a digital agency) based in Milan, Italy (Via Tertulliano 70, 20137 Milano). [[alessio-antonucci]] had a documented hiring/employment relationship with the studio from the July-August 2024 interview process through employment in October 2024-March 2025. Later 2025-2026 sources concern tax paperwork, reference letters, and retrospective descriptions rather than ongoing employment."],
  [/- \*\*April 2026:\*\* Alessio self‑reported developing WCAG‑compliant accessibility web apps for the studio\./, "- **April 2026:** Alessio used the DotDotDot accessibility experience retrospectively in a cold email/application context; this is not evidence of ongoing DotDotDot employment."],
  [/- \*\*\[\[giovanna-gardi\]\]\*\* – Co‑founder \/ HR \(giovanna@dotdotdot\.it\) – signed the reference letter and is available for further information\./, "- **[[giovanna-gardi]]** – Co-founder / HR (`giovanna@dotdotdot.it`) – signed the reference letter and is the named reference contact from the DotDotDot dossier."],
]);

changed += replace("wiki/people/giovanna-gardi.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/Can serve as a professional reference for Alessio’s tenure at Dotdotdot \(October 2024 – March 2025\)\./, "Best treated as the primary professional reference contact for Alessio’s Dotdotdot tenure (October 2024 – March 2025), because she signed and transmitted the reference letter."],
]);

changed += replace("wiki/topics/digital-accessibility.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
]);
changed += ensure(
  "wiki/topics/digital-accessibility.md",
  "## Reference Letter Usage",
  `
## Reference Letter Usage

The Dotdotdot reference letter should be treated as the strongest reusable evidence for Alessio's professional accessibility work. It is especially relevant when accessibility, inclusive design, or disability-informed product work is a differentiator; it does not need to be foregrounded for every general software application.
`
);

changed += replace("wiki/sources/8-carriera--7-lettere--26-reference-letter-dotdotdot--11wcveh.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
]);
changed += ensure(
  "wiki/sources/8-carriera--7-lettere--26-reference-letter-dotdotdot--11wcveh.md",
  "## Use as Reference",
  `
## Use as Reference

This letter is actionable as a professional reference source for Dotdotdot and accessibility-focused applications. Giovanna Gardi is the named signer/contact. The best use is selective: foreground it where accessibility or inclusive design is directly relevant.
`
);

// Mark reviews resolved.
const resolved = new Map([
  ["review-6", "Bebe repository located and linked."],
  ["review-9", "CrispyByte metrics retained as true historical project metrics, with note that raw data is no longer available."],
  ["review-10", "CV 3 PDF metadata recorded: exported 2024-07-20 from Pages."],
  ["review-23", "DotDotDot timeline reconciled as employment Oct 2024-Mar 2025; later sources are reference/tax/retrospective context."],
  ["review-39", "Crypto involvement added to passions/interests as real financial-learning history."],
  ["review-40", "Fourth-year high-school videogame course attempt added to freelance game-development history."],
  ["review-42", "Terra/Luna crypto loss documented as a real investment lesson."],
  ["review-53", "Dotdotdot reference letter positioned as strongest reusable accessibility-work evidence."],
  ["review-54", "Giovanna Gardi reference-contact handling clarified."],
]);

const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
for (const item of review) {
  if (resolved.has(item.id)) {
    item.resolved = true;
    item.resolvedAt = new Date().toISOString();
    item.resolution = resolved.get(item.id);
  }
}
fs.writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);

console.log(`Changed ${changed} files/operations and resolved ${resolved.size} review items.`);
