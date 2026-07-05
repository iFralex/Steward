import fs from "node:fs";
import path from "node:path";

const root = "/Users/alessioantonucci/Second Me";
const reviewPath = path.join(root, ".llm-wiki", "review.json");
const today = "2026-07-04";

function file(rel) {
  return path.join(root, rel);
}

function replace(rel, pairs) {
  let text = fs.readFileSync(file(rel), "utf8");
  const before = text;
  for (const [from, to] of pairs) text = text.replace(from, to);
  if (text !== before) fs.writeFileSync(file(rel), text);
  return text !== before ? 1 : 0;
}

let changed = 0;

changed += replace("wiki/topics/bending-spoons-scholarship.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/Alessio committed to applying; the outcome of his application is not documented in available sources\. This scholarship approach may serve as a precedent for future similar applications\./, "Alessio committed to applying; the application did not lead to a scholarship or offer. This scholarship approach may serve as a precedent for future similar applications."],
]);

changed += replace("wiki/organizations/bending-spoons.md", [
  [/updated: 2026-07-03/, `updated: ${today}`],
  [/The email threads reveal that the scholarship was actively promoted in April 2024, but by the time Alessio applied via MultiChance, it was no longer available, prompting a redirect to a Google internship\./, "The email threads reveal that the scholarship was actively promoted in April 2024, but by the time Alessio applied via MultiChance, it was no longer available, prompting a redirect to a Google internship. The Bending Spoons scholarship/application path did not lead to a scholarship or offer."],
]);

const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
for (const item of review) {
  if (item.id === "review-255" || item.id === "review-268") {
    item.resolved = true;
    item.resolvedAt = new Date().toISOString();
    item.resolution = "Bending Spoons scholarship/application outcome recorded as no scholarship/no offer.";
  }
}
fs.writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);

console.log(`Changed ${changed} files and resolved Bending outcome reviews.`);
