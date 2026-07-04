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
  if (text !== before) {
    write(rel, text);
    return 1;
  }
  return 0;
}

function ensure(rel, marker, block) {
  const text = read(rel);
  if (text.includes(marker)) return 0;
  write(rel, `${text.replace(/\s*$/, "")}\n\n${block.trim()}\n`);
  return 1;
}

let changed = 0;

// Application outcomes.
for (const rel of [
  "wiki/experiences/xian-summer-camp-2026-application.md",
  "wiki/experiences/goldman-sachs-employability-2025-application.md",
  "wiki/experiences/mongodb-application.md",
  "wiki/experiences/cm-com-graduation-internship-application-2025.md",
]) {
  if (!fs.existsSync(file(rel))) continue;
  changed += replace(rel, [
    [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
    [/status: (not_accepted|completed|uncertain)/, "status: rejected"],
    [/was rejected or did not lead to an offer/g, "was rejected and did not lead to an offer"],
  ]);
}

changed += replace("wiki/experiences/xian-summer-camp-2026-application.md", [
  [/- \*\*Outcome:\*\* Not accepted\./, "- **Outcome:** Rejected / not accepted."],
  [/\n## Open Questions\n\n- What were the practical logistics of traveling to China with a guide dog\? \(Did Rasta travel\? How was the airport\/hotel experience\?\)\n?/, "\n"],
]);

changed += replace("wiki/experiences/goldman-sachs-employability-2025-application.md", [
  [/## Outcome\n\nRejected \/ no offer received\. No response or rejection notice is available in the wiki corpus\./, "## Outcome\n\nRejected / no offer received."],
]);

changed += replace("wiki/experiences/mongodb-application.md", [
  [/No information about the specific role or application date is available\. The application was rejected and did not lead to an offer\./, "No information about the specific role or application date is available. The application was rejected and did not lead to an offer."],
]);

changed += replace("wiki/experiences/cm-com-graduation-internship-application-2025.md", [
  [/- \*\*Outcome\*\*: Rejected \/ no offer received/, "- **Outcome**: Rejected / no offer received"],
]);

// DiscoverEU travel insurance.
changed += replace("wiki/events/discovereu-2026.md", [
  [/updated: 2026-07-03/, `updated: ${today}`],
  [/- \*\*Recommended:\*\* Personal travel insurance for non-medical emergencies \(repatriation, hospitalization costs, lost tickets\)/, "- **Recommended but declined:** Personal travel insurance for non-medical emergencies (repatriation, hospitalization costs, lost tickets)"],
  [/- The European Disability Card has been obtained; personal travel insurance is still not documented/, "- The European Disability Card has been obtained; Alessio does not plan to purchase separate personal travel insurance"],
]);

// MioMondo BNL.
changed += replace("wiki/topics/mio-mondo-bnl-insurance.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/MioMondo is an insurance product offered by BNL \(Banca Nazionale del Lavoro\)\. Alessio holds a policy with contract reference NCAR0094294\./, "MioMondo is an insurance product name appearing on historical BNL account statements with contract reference NCAR0094294. The product is not part of Alessio's recognized current setup, and its exact coverage is unknown."],
  [/## Likely Nature[\s\S]*?## Relevance to Alessio[\s\S]*?## Open Questions/, `## Interpretation\n\nThe statement description proves that a recurring charge existed in Q1 2024, but the wiki should not treat MioMondo as known active travel or health insurance. Alessio does not recognize the policy name, and BNL is now closed.\n\n## Open Questions`],
  [/- Whether this policy is still active \(only evidenced for Q1 2024\)\./, "- Whether the policy was cancelled automatically or manually when/after the BNL account was closed."],
]);

changed += replace("wiki/topics/financial-profile.md", [
  [/updated: 2026-07-03/, `updated: ${today}`],
  [/- \*\*MioMondo BNL Policy\*\*: Recurring monthly charge of €74\.59, deducted around the 5th–6th of each month for the following month's coverage\. Likely travel or health insurance\. See \[\[mio-mondo-bnl-insurance\]\]\./, "- **MioMondo BNL Policy**: Historical recurring monthly charge of €74.59 in Q1 2024. Exact coverage is unknown, and it should not be treated as known active insurance. See [[mio-mondo-bnl-insurance]]."],
  [/1\. What is the exact source of the historical BNL "emolumenti" credit\? Could be freelance income, scholarship, or a part-time role\.\n2\. What was the historical €600\/month "bonifico a vostro favore"\? Likely a recurring family contribution or retainer fee\.\n3\. What did the €3,000 pending BNL commitment represent\? Possibly a security deposit, tuition payment, or a hold for a large purchase\./, "1. What is the exact source of the historical BNL \"emolumenti\" credit? Unknown.\n2. What was the historical €600/month \"bonifico a vostro favore\"? Unknown.\n3. What did the €3,000 pending BNL commitment represent? Unknown."],
]);

// CandidAI current commercial status.
changed += replace("wiki/projects/candidai.md", [
  [/updated: 2026-07-03/, `updated: ${today}`],
  [/The frontend was completed later\. Launch plans included a €1,000 marketing campaign in 2 weeks \(from the letter date, estimated early 2026\)\. The letter notes the project was "born 6 months ago" \(approx\. mid-2025 if letter is early 2026\)\./, "The frontend was completed later. As of July 2026, CandidAI is online and in the commercial validation phase: Alessio is looking for paying users through marketing. The letter notes the project was \"born 6 months ago\" (approx. mid-2025 if letter is early 2026)."],
  [/## Open Questions\n\n- Did the €1,000 marketing campaign happen\? Results\?\n/, "## Open Questions\n\n- What are the results of the current marketing/user-acquisition effort?\n"],
  [/- Current status of the product and the stalled collaborations\.\n- The full scope, timeline, and current status of the CandidAI project are not fully documented\./, "- Whether paying users convert from the current marketing effort.\n- The full scope and timeline of the stalled collaborations."],
]);
changed += ensure(
  "wiki/projects/candidai.md",
  "## Current Commercial Status",
  `
## Current Commercial Status

CandidAI is online and currently searching for paying users through marketing. The project should be described as commercially active but still in user-acquisition/validation, not as a proven product with documented paying customers.
`
);

changed += replace("wiki/projects/candidai-tech.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
]);
changed += ensure(
  "wiki/projects/candidai-tech.md",
  "## Current Commercial Status",
  `
## Current Commercial Status

The site is online and is being used for marketing/user acquisition for CandidAI. The current goal is to find paying users.
`
);

const resolved = new Map([
  ["review-2", "CandidAI status updated as online and in paid-user acquisition via marketing."],
  ["review-50", "Xi'an Summer Camp outcome recorded as rejected/not accepted."],
  ["review-77", "DiscoverEU personal travel insurance decision recorded as not planned."],
  ["review-107", "MioMondo recorded as historical BNL statement item with unknown coverage and no recognized current role."],
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
