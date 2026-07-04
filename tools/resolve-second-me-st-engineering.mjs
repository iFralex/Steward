import fs from "node:fs"
import path from "node:path"

const projectRoot = "/Users/alessioantonucci/Second Me"
const reviewPath = path.join(projectRoot, ".llm-wiki", "review.json")

function read(file) {
  return fs.readFileSync(file, "utf8")
}

function write(file, content) {
  fs.writeFileSync(file, content)
}

function replaceExact(file, from, to) {
  const content = read(file)
  if (!content.includes(from)) {
    throw new Error(`Pattern not found in ${file}: ${from.slice(0, 80)}`)
  }
  write(file, content.replace(from, to))
}

function upsertSection(file, heading, body) {
  const content = read(file)
  const section = `\n\n## ${heading}\n\n${body.trim()}\n`
  if (content.includes(`## ${heading}\n`)) {
    const re = new RegExp(`\\n\\n## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?(?=\\n\\n## |$)`)
    write(file, content.replace(re, section))
    return
  }
  write(file, `${content.trimEnd()}${section}`)
}

const files = {
  software: path.join(projectRoot, "wiki/experiences/software-engineer-st-engineering-antycip.md"),
  ai: path.join(projectRoot, "wiki/experiences/ai-engineer-st-engineering-antycip.md"),
  lead: path.join(projectRoot, "wiki/experiences/software-engineer-ai-division-st-engineering-antycip.md"),
  employment: path.join(projectRoot, "wiki/experiences/employment-st-engineering-antycip.md"),
  org: path.join(projectRoot, "wiki/organizations/st-engineering-antycip.md"),
  person: path.join(projectRoot, "wiki/people/alessio-antonucci.md"),
}

replaceExact(
  files.software,
  "The formal employment contract (dated 24 January 2024, effective 17 February 2025) specifies:",
  "The initial formal employment contract (effective 17 February 2025) specifies:",
)

replaceExact(
  files.software,
  "> **Note**: The contractual title is “Software Developer,” not “Software Engineer” or “C++ Software Engineer.” The role is part‑time (21h/week), which is not mentioned in Alessio’s CV. The fixed‑term contract expired on 16 August 2025; its renewal status is formally unconfirmed. However, a smart working agreement signed in January 2026 suggests continued employment.",
  "> **Resolution**: The title variance is best treated as layered evidence rather than separate jobs. The contract gives the legal title (**Software Developer**), early internal correspondence uses **Software Developer**, the July 2025 internal newsletter uses **AI Engineer**, and CVs/letters tailor the public title as **C++ Software Engineer**, **Software Engineer**, or **Software Engineer / AI Division Lead**. The fixed-term contract was superseded by a permanent contract signed on **12 September 2025** ([[permanent-contract-st-engineering-antycip-2025-09-12]]), so continued employment after August 2025 is confirmed. The exact terms of the permanent contract are not extracted.",
)

replaceExact(
  files.software,
  "- **Fixed‑term end**: 16 August 2025 (renewal unconfirmed)\n- **Current status**: Listed as current in CV6 and by subsequent smart‑working agreement (January 2026). Formal employment status after August 2025 is unverified.",
  "- **Fixed‑term end**: 16 August 2025\n- **Permanent contract**: signed 12 September 2025 ([[permanent-contract-st-engineering-antycip-2025-09-12]])\n- **Current status**: Continued employment confirmed by the permanent contract and later operational sources, including smart-working, website, hosting, MAK/demo-license, presence-reporting, and workshop emails.",
)

replaceExact(
  files.ai,
  "**Note**: The contractual title is \"Software Developer\" at a junior classification, not \"AI Engineer.\" The role is part-time (21h/week), a detail absent from all CVs and cover letters. The contract expired on 16 August 2025; its renewal status is unknown, though the smart working agreement (January 2026) implies continued employment. The descriptions below likely reflect evolved responsibilities beyond the original contract.",
  "**Resolution**: The legal title and the functional title differ but can be reconciled. The initial contract records the formal job title as \"Software Developer\" and the initial schedule as part-time. Later internal HR-facing material (July 2025 newsletter) records Alessio's self-reported title as \"AI Engineer,\" while CVs and application letters adapt the title for audience and emphasis. The fixed-term contract was followed by a permanent contract signed on 12 September 2025 ([[permanent-contract-st-engineering-antycip-2025-09-12]]). The exact permanent-contract hours, salary, and classification remain unknown, but continued employment is no longer in doubt.",
)

replaceExact(
  files.ai,
  "Listed as current in CV7 and the Xi'an Summer Camp cover letter. Formal contract status after 16 Aug 2025 is unconfirmed, but the existence of a smart working agreement (January 2026) suggests continued employment under some arrangement.",
  "Listed as current in CV7 and the Xi'an Summer Camp cover letter. Continued employment after 16 Aug 2025 is confirmed by the permanent contract signed on 12 September 2025 and by later 2026 operational sources. The only unresolved contractual details are the permanent-contract terms, not the employment status.",
)

replaceExact(
  files.lead,
  "**Note**: The contractual title is more junior than the self-described \"AI Division Lead.\" The part-time nature (21h/week) is not disclosed in any CV or cover letter. The contract expired on 16 August 2025; its renewal status is unknown, though a smart working agreement from January 2026 ([[st-engineering-antycip-smart-working]]) suggests continued employment. The role may have expanded significantly after the trial period or the contract may have been upgraded upon renewal.",
  "**Resolution**: The apparent contradiction is resolved as title layering plus role evolution. \"Software Developer\" is the legal/contractual title in the initial contract; \"AI Engineer\" is the HR/internal-newsletter title communicated in July 2025; \"Software Engineer / AI Division Lead\" is the CV/application framing of the same employment. The fixed-term contract was later superseded by a permanent contract signed on 12 September 2025 ([[permanent-contract-st-engineering-antycip-2025-09-12]]). Exact permanent-contract terms remain unextracted.",
)

replaceExact(
  files.lead,
  "- The formal contract states a part-time (21h/week) arrangement that is not reflected in any self-description; the CV and letter imply full-time commitment.",
  "- The formal contract states a part-time (21h/week) arrangement for the initial fixed-term contract. Later CV/letter wording implies broad responsibility, but does not prove full-time legal status. The permanent contract confirms continuation, while its exact hours remain unknown.",
)

replaceExact(
  files.lead,
  "Listed as current in CV8 (early 2026). Formal contract status after 16 Aug 2025 is unconfirmed, but a smart working agreement ([[st-engineering-antycip-smart-working]]) from January 2026 indicates ongoing employment.",
  "Listed as current in CV8 (early 2026). Ongoing employment is confirmed by the permanent contract signed on 12 September 2025 and later 2026 operational evidence.",
)

replaceExact(
  files.employment,
  "- The working hours (9:00–18:00) represent a full 9‑hour workday. Whether this is full‑time or part‑time (given the part‑time designation and RAL €14k in the job offer) is an open question — a long lunch break or compressed schedule may account for the discrepancy.",
  "- The 9:00–18:00 line should be treated as an availability/onboarding working-hours instruction, not as proof that the initial contract was full-time. The initial legal contract explicitly states part-time, 21 hours/week. A permanent contract was signed on 12 September 2025, but its exact weekly hours are not extracted, so the remaining unknown is the permanent-contract schedule rather than whether the initial fixed-term contract was part-time.",
)

upsertSection(
  files.org,
  "Role Title Reconciliation",
  `The ST Engineering Antycip title variance is now resolved as layered evidence rather than separate simultaneous jobs:

- **Legal title in initial contract:** Software Developer (Sviluppatore software), 5° Livello, part-time 21h/week.
- **Early internal/team usage:** Software Developer, covering web applications, website work, and Unreal Engine support.
- **July 2025 HR/internal newsletter:** AI Engineer, with responsibility for machine-learning integration in VR-Forces.
- **CV/application framing:** C++ Software Engineer, AI Engineer, Software Engineer, or Software Engineer / AI Division Lead depending on audience and emphasis.

The fixed-term contract ending 16 August 2025 was superseded by a permanent contract signed on **12 September 2025** ([[permanent-contract-st-engineering-antycip-2025-09-12]]). Later smart-working, hosting, website, presence-reporting, demo-license, and workshop sources confirm ongoing employment. The only remaining contractual gap is the exact permanent-contract salary, level, and weekly hours.`,
)

replaceExact(
  files.person,
  "Alessio works part-time at [[st-engineering-anticyp|ST Engineering Antycip]]. His initial role involved AI-powered [[vr-forces|VR-Forces simulations]].",
  "Alessio works at [[st-engineering-anticyp|ST Engineering Antycip]]. The initial fixed-term contract identified him legally as a part-time **Software Developer**, while later internal and CV-facing materials describe the same employment as **AI Engineer**, **Software Engineer**, **C++ Software Engineer**, or **Software Engineer / AI Division Lead** depending on context. A permanent contract signed on **12 September 2025** confirms continued employment after the initial fixed-term period.",
)

const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"))
const ids = new Set(["review-25", "review-32", "review-59", "review-190", "review-191", "review-531"])
for (const item of review) {
  if (!ids.has(item.id)) continue
  item.resolved = true
  item.resolvedAt = item.resolvedAt ?? Date.now()
  item.resolution = "Resolved by reconciling ST Engineering Antycip evidence as layered title usage: legal contract title, internal HR title, and CV/application framing. Continued employment after the fixed-term contract is confirmed by the 2025-09-12 permanent contract; exact permanent-contract terms remain an explicit residual unknown."
}
fs.writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`)
