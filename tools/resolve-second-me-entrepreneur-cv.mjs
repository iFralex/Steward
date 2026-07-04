import fs from "node:fs"
import path from "node:path"

const root = "/Users/alessioantonucci/Second Me"
const reviewPath = path.join(root, ".llm-wiki/review.json")

function read(file) {
  return fs.readFileSync(file, "utf8")
}

function write(file, content) {
  fs.writeFileSync(file, content)
}

function appendIfMissing(file, heading, body) {
  const content = read(file)
  if (content.includes(`## ${heading}\n`)) return
  write(file, `${content.trimEnd()}\n\n## ${heading}\n\n${body.trim()}\n`)
}

function replaceExact(file, from, to) {
  const content = read(file)
  if (!content.includes(from)) {
    throw new Error(`Pattern not found in ${file}: ${from}`)
  }
  write(file, content.replace(from, to))
}

const unified = path.join(root, "wiki/experiences/web-software-engineer-entrepreneur-unified.md")
const shopify = path.join(root, "wiki/experiences/e-commerce-operations-shopify.md")
const candidai = path.join(root, "wiki/projects/candidai.md")

appendIfMissing(
  unified,
  "Review Resolution: Start Date and Portfolio Evolution",
  `The 2022-07 start date should be read as the start of the **umbrella entrepreneurial role**, not as proof that every listed project began on that date. The individual projects have different evidence windows:

- [[e-commerce-operations-shopify]] is only documented in CV1 and appears to be an early, later-deprioritised activity.
- [[unica]] has independent evidence from January 2023 onward.
- [[crispybyte]] and [[monitor-analyze-structural-data]] are carried through several CV versions but may represent different degrees of commercial vs academic work.
- [[candidai]] appears later, with operational evidence mainly in late 2025 and 2026.

The CV sequence is therefore best interpreted as portfolio reframing over time: older retail/e-commerce activity was dropped, core software/product projects were retained, and CandidAI was added in later project/application material. This resolves the apparent contradiction around the uniform 2022-07 start date.`,
)

appendIfMissing(
  shopify,
  "Review Resolution",
  `The disappearance of the Shopify stores from later CVs is treated as **portfolio de-prioritisation**, not as evidence that the original CV1 claim was false. CV1 is the only known source with this activity, so the page remains historical and low-detail. Later CVs shift the entrepreneurial narrative toward software products ([[unica]], [[crispybyte]], [[monitor-analyze-structural-data]], [[youtuberai]]) and eventually [[candidai]]. Until a store name, domain, sales record, or closure evidence appears, the correct representation is: documented once, likely short-lived or omitted for relevance.`,
)

replaceExact(
  candidai,
  "- Why is CandidAI omitted from CV8 (early 2026) if the EIT Digital letter (also ~early 2026) promotes it as the flagship project?",
  "- Why CandidAI is omitted from some CVs after it became operational remains a portfolio-framing question. The omission from **CV5 (early 2025)** is no longer treated as a contradiction because available evidence places CandidAI's documented operational activity later, mainly in late 2025 and 2026.",
)

appendIfMissing(
  candidai,
  "Review Resolution: CV Omissions",
  `CandidAI's absence from CV5 is resolved by dating: CV5 is an early-2025 document, while the strongest project evidence appears later (late 2025/2026), including CandidAI project documentation, payment-processing activity, video/promo work, and later application letters. Later omissions from some CVs are best treated as audience-specific portfolio selection rather than a factual contradiction: Alessio sometimes foregrounds UNICA/YouTuberAI/CrispyByte or ST Engineering Antycip instead of CandidAI, depending on the target role.`,
)

const review = JSON.parse(read(reviewPath))
const ids = new Set(["review-12", "review-15", "review-18", "review-21"])
for (const item of review) {
  if (!ids.has(item.id)) continue
  item.resolved = true
  item.resolvedAt = item.resolvedAt ?? Date.now()
  item.resolution = "Resolved as CV timeline/portfolio framing: 2022-07 is the umbrella entrepreneurial role start, Shopify is a historical CV1-only activity, and CandidAI's absence from CV5 is explained by CV5 predating the strongest CandidAI evidence. Later omissions remain audience-specific CV selection, not factual contradiction."
}
write(reviewPath, `${JSON.stringify(review, null, 2)}\n`)
