#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/alessioantonucci/Second Me";
const TODAY = "2026-07-04";

function p(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(p(rel), "utf8");
}

function write(rel, text) {
  fs.writeFileSync(p(rel), text);
}

function setUpdated(text) {
  return text.replace(/^updated: .+$/m, `updated: ${TODAY}`);
}

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Missing expected text for ${label}`);
  return text.replace(from, to);
}

function addAfter(text, marker, block, label) {
  if (text.includes(block.trim().split("\n")[0])) return text;
  if (!text.includes(marker)) throw new Error(`Missing marker for ${label}`);
  return text.replace(marker, `${marker}${block}`);
}

function resolve(ids, notes) {
  const reviewPath = p(".llm-wiki/review.json");
  const data = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  const missing = new Set(ids);
  const now = new Date().toISOString();
  for (const item of data) {
    if (missing.has(item.id)) {
      item.resolved = true;
      item.resolvedAt = now;
      item.resolution = notes[item.id] ?? "Resolved from user clarification.";
      missing.delete(item.id);
    }
  }
  if (missing.size) throw new Error(`Missing review ids: ${[...missing].join(", ")}`);
  fs.writeFileSync(reviewPath, JSON.stringify(data, null, 2) + "\n");
}

// Graduation status: not completed yet; degree exam remains scheduled for 15 July 2026.
{
  const rel = "wiki/topics/graduation-timeline.md";
  let text = setUpdated(read(rel));
  text = mustReplace(
    text,
    "Alessio Antonucci’s expected graduation from [[politecnico-di-milano]] is documented in two sources from late 2023, both indicating **2026** as the target year.",
    "Alessio Antonucci's expected graduation from [[politecnico-di-milano]] is documented in earlier 2023 sources and later refined by the scheduled Bachelor's degree exam on **15 July 2026**.",
    "graduation intro",
  );
  text = mustReplace(
    text,
    "| Google Internship Application | later in 2023 | Expected graduation date **September 2026** |",
    "| Google Internship Application | later in 2023 | Expected graduation date **September 2026** |\n| Bachelor's degree exam scheduling | July 2026 | Degree exam scheduled for **15 July 2026** at DEIB; this is the current expected completion date |",
    "graduation table",
  );
  text = mustReplace(
    text,
    "Both sources are consistent and were self‑reported; they have not been independently confirmed. The September 2026 date likely refers to completion of the Bachelor’s degree, with a Master’s program beginning in autumn 2026, extending the total study period beyond 2026 (probably to 2028).",
    "The older September 2026 estimate has been superseded by the July 2026 degree-exam scheduling. As of 4 July 2026, the degree has not yet been completed; the exam is still planned for 15 July 2026.",
    "graduation supersession",
  );
  text = mustReplace(
    text,
    `## Status

**Uncertain.** No updated graduation date or confirmation of degree completion has been recorded in any source ingested as of June 2026. The earliest documented source is the STEP questionnaire ([[mail-thread-29298]]).

## Open Questions

- Did Alessio graduate in September 2026, or did the date change?
- Is he currently still enrolled, or has he completed his Bachelor’s?
- If he is pursuing a Master’s, when does that program start and end?
- How did his employment at dotdotdot and ST Engineering Antycip affect his academic schedule?`,
    `## Status

**Scheduled, not yet completed.** The current known status is a Bachelor's degree exam scheduled for **15 July 2026**. This page should be updated after the exam with the actual outcome and final degree date.

## Open Questions

- What was the outcome of the 15 July 2026 degree exam?
- What is the final official degree date recorded by Politecnico di Milano?
- How will the completed Bachelor's timeline connect to the EIT Digital / KTH Master's path?`,
    "graduation status",
  );
  write(rel, text);
}

{
  const rel = "wiki/events/bachelor-degree-exam-july-2026.md";
  let text = setUpdated(read(rel));
  text = mustReplace(
    text,
    "- **Exam outcome:** The result of the exam is unknown from this source alone.",
    "- **Exam outcome:** The exam has not happened yet as of 4 July 2026; Alessio plans to take it on 15 July 2026.",
    "bachelor exam outcome",
  );
  write(rel, text);
}

// Google: CSE material was prepared but not ultimately submitted.
{
  const rel = "wiki/experiences/customer-solutions-engineer-google-application.md";
  let text = setUpdated(read(rel));
  text = text.replace("status: rejected", "status: not-submitted");
  text = mustReplace(
    text,
    "Alessio submitted an application for a **Customer Solutions Engineer** position within the **gTech Ads** team at Google. The application was submitted directly by Alessio (not through a referral or recruiting event) on **10 March 2026**, as documented by:",
    "Alessio prepared application materials for a **Customer Solutions Engineer** position within the **gTech Ads** team at Google, but ultimately did not submit the application. The materials are documented by:",
    "CSE opening",
  );
  text = mustReplace(
    text,
    `## Application Status

The cover letter source itself records no outcome – no offer, rejection, or further correspondence is documented in the wiki from that channel. However, later confirmation from Alessio (June 2026) indicates that the application was **rejected / no offer received**. The status is therefore listed as rejected, though the submission confirmation itself has not been indexed.`,
    `## Application Status

No final application was submitted for this CSE role. The CV and cover letter remain useful as evidence of positioning toward MarTech/customer-facing technical work, but the role should not be counted as an actual Google application, rejection, interview, or offer.`,
    "CSE status",
  );
  text = text.replace(
    "- Application method (self‑submitted directly to Google) is distinct from the Multichance 2026 application ([[google-application-multichance-2026]]), which targeted a STEP role earlier.",
    "- This prepared-but-not-submitted CSE package is distinct from the Multichance 2026 Google/STEP opportunity and from earlier Google internship records.",
  );
  write(rel, text);
}

{
  const rel = "wiki/organizations/google.md";
  let text = setUpdated(read(rel));
  text = text
    .replace(
      "- **2023/2024** – Submitted STEP (Student Training in Engineering Program) internship application with a cover letter detailing self‑taught programming journey. Status unknown.",
      "- **2023/2024** – Google STEP/internship materials and preference questionnaire were prepared/documented. No final successful application, interview, offer, or rejection is documented.",
    )
    .replace(
      "- **April 2024** – Applied for a Google internship through the [[employ-ability-org]] platform, using reference letters from [[dafne-forloni]] (MultiChance) and Professor [[cristiana-bolchini]]. Deadline was April 23, 2024. Outcome unknown.",
      "- **April 2024** – Explored a Google internship through the [[employ-ability-org]] platform, using reference letters from [[dafne-forloni]] (MultiChance) and Professor [[cristiana-bolchini]]. The opportunity was not ultimately completed as an application.",
    )
    .replace(
      "- **2026** – Prepared a highly tailored CV for the **Customer Solutions Engineer** role, evidencing a shift from engineering internships to a customer‑facing technical role ([[sources/2-cv--26-471da2a38f6ea3bf-cv-google--iyqw03|CV-Google.pdf]]). No submission evidence found.",
      "- **2026** – Prepared a highly tailored CV and cover letter for the **Customer Solutions Engineer** role, evidencing a shift from engineering internships to a customer-facing technical role. The application was not ultimately submitted.",
    )
    .replace(
      "| STEP Internship | [[google-step-internship-application]] | 2023/2024 | Unknown |\n| Internship (via employ‑ability.org) | [[employ-ability-org]] | April 2024 | Unknown |",
      "| STEP Internship | [[google-step-internship-application]] | 2023/2024 | Materials/preference questionnaire documented; no completed successful application |\n| Internship (via employ-ability.org) | [[employ-ability-org]] | April 2024 | Not ultimately applied |",
    )
    .replace(
      "| Customer Solutions Engineer | [[customer-solutions-engineer-google-application]] | 2026 | Unknown (CV only, no submission evidence) |",
      "| Customer Solutions Engineer | [[customer-solutions-engineer-google-application]] | 2026 | Prepared but not submitted |",
    )
    .replace(
      "- Are the two internship applications (STEP via cover letter, the 2023 one via Sai Kumar N Srihari, and the April 2024 one via employ‑ability.org) the same or distinct? No evidence currently links them.",
      "- Are the older Google internship traces (STEP/preference questionnaire, Sai Kumar N Srihari contact, and employ-ability.org materials) the same opportunity or separate preparation tracks? No evidence currently links them cleanly.",
    );
  write(rel, text);
}

{
  const rel = "wiki/projects/google-internship-application.md";
  let text = setUpdated(read(rel));
  text = mustReplace(
    text,
    "Alessio Antonucci applied for a Google internship in 2023. The application has two documented phases:",
    "Alessio Antonucci prepared Google internship materials in 2023. The process has two documented phases:",
    "google internship project intro",
  );
  text = mustReplace(
    text,
    "- No reply or follow-up from Google has been documented.\n- The exact timeline of the second application is unclear; it may have been part of the same STEP process or a different internship posting.",
    "- No final successful application, interview, offer, or rejection is documented.\n- The later internship opportunity was not ultimately completed as an application.\n- The exact timeline of the second application record is unclear; it may have been part of the same STEP process or a different internship posting.",
    "google internship project status",
  );
  write(rel, text);
}

// Property deposits and mortgage.
{
  const rel = "wiki/topics/property-cisterna-di-latina.md";
  let text = setUpdated(read(rel));
  text = mustReplace(
    text,
    "The security deposit transfer request was sent via PEC on **4 June 2026**. As of the available sources, no confirmation of transfer has been received.",
    "The security deposit transfer request was sent via PEC on **4 June 2026**. Later status: Alessio's tenant deposit for int. 4 was transferred/received; Giulia's int. 5 deposit had not yet been transferred.",
    "deposit status",
  );
  text = mustReplace(
    text,
    "- **Deposit figures**: €1,616 paid / €2,016 owed differ from the €1,200 + €1,150 transfer request – clarification needed.",
    "- **Deposit figures**: €1,616 paid / €2,016 owed differ from the €1,200 + €1,150 transfer request; Alessio's int. 4 deposit has been received, while Giulia's int. 5 deposit remains outstanding.",
    "deposit unresolved point",
  );
  if (!text.includes("## Mortgage and Family Financing Context")) {
    text = text.replace(
      "## Solar panel note\n",
      `## Mortgage and Family Financing Context

The purchase was preceded by a 2024 bank-shopping process across several banks for the rental property next to Alessio's family home at Via delle Orchidee. The mortgage ultimately documented in family context was a **€94,000**, **20-year** loan at **4.1%**, formally in [[sonia-marfoli]]'s name, with a monthly payment of about **€550**. A later early repayment of **€70,000** reduced the remaining balance to about **€18,000**; the family plan is to extinguish the remaining balance within 1-2 years if possible.

## Solar panel note
`,
    );
  }
  write(rel, text);
}

{
  const rel = "wiki/topics/financial-profile.md";
  let text = setUpdated(read(rel));
  if (!text.includes("### Family Mortgage for Rental Property")) {
    text = text.replace(
      "## Housing Costs\n",
      `### Family Mortgage for Rental Property

The 2024 mortgage-search documents relate to the family purchase of the property now rented out near the Via delle Orchidee family home. The mortgage was formalized in [[sonia-marfoli]]'s name for **€94,000** over **20 years** at **4.1%**, with an approximate monthly payment of **€550**. A **€70,000** early repayment later reduced the outstanding principal to about **€18,000**. Alessio's current plan is to extinguish the remaining balance within roughly 1-2 years.

This should be treated as a family/property financing commitment tied to Sonia's formal borrower role, not as an unresolved generic bank inquiry.

## Housing Costs
`,
    );
  }
  write(rel, text);
}

{
  const rel = "wiki/people/sonia-marfoli.md";
  let text = setUpdated(read(rel));
  text = text.replace(
    "- **Credem mortgage feasibility check (January 2024):** Sonia Marfoli provided her CUD 2023 (tax certificate) to Alessio for a mortgage feasibility check with [[credem]] ([[mail-thread-28389]]). This shows her role as a co‑provider of income documents for Alessio's mortgage applications.",
    "- **Mortgage for adjacent rental property:** Sonia Marfoli was the formal borrower for a family mortgage used to purchase the property now rented out near the Via delle Orchidee family home. The mortgage was €94,000 over 20 years at 4.1%, with a monthly payment of about €550; after a €70,000 early repayment, about €18,000 remained outstanding. The January 2024 Credem feasibility check and related CUD sharing were part of this bank-shopping process ([[mail-thread-28389]]).",
  );
  text = text.replace(
    "- **Credem mortgage feasibility check (January 2024):** [[mail-thread-28389]] shows she provided her CUD 2023 for Alessio's mortgage application.",
    "- **Mortgage/bank-shopping documentation (January 2024):** [[mail-thread-28389]] shows she provided her CUD 2023 as part of the bank-shopping process for the family rental-property mortgage later formalized in her name.",
  );
  write(rel, text);
}

{
  const rel = "wiki/organizations/credem.md";
  let text = setUpdated(read(rel));
  text = mustReplace(
    text,
    "In January 2024, [[alessio-antonucci]] contacted Credem for a mortgage feasibility check, submitting his INPS pay slip and his mother [[sonia-marfoli]]'s CUD 2023 as income documentation. The outcome of this request is unknown.",
    "In January 2024, [[alessio-antonucci]] contacted Credem for a mortgage feasibility check, submitting his INPS pay slip and his mother [[sonia-marfoli]]'s CUD 2023 as income documentation. This was part of a broader 2024 bank-shopping process to finance the purchase of the rental property near the Via delle Orchidee family home. The mortgage was ultimately formalized in Sonia Marfoli's name for €94,000 over 20 years at 4.1%, with a monthly payment of about €550; after a €70,000 early repayment, around €18,000 remained outstanding.",
    "Credem mortgage outcome",
  );
  write(rel, text);
}

// UNICA: historically important, not active now; license not pursued.
{
  const rel = "wiki/projects/unica-brand.md";
  let text = setUpdated(read(rel));
  text = text.replace("status: uncertain", "status: historical");
  text = mustReplace(
    text,
    "UNICA is a European jewelry brand founded by [[alessio-antonucci]] in early 2023. The brand focused on 3D‑designed earring models targeting European e‑commerce customers. Despite extensive planning, multiple partner negotiations, and a commissioned promotional video, there is no confirmed evidence of production, sales, or a public launch.",
    "UNICA is a historically important jewelry-brand project founded by [[alessio-antonucci]] in early 2023. The brand focused on 3D-designed earring models targeting European e-commerce customers. It is not currently active, but it should remain documented as a major historical entrepreneurial project. Despite extensive planning, multiple partner negotiations, and a commissioned promotional video, there is no confirmed evidence of production, sales, or a public launch.",
    "UNICA intro",
  );
  text = text.replace(
    "- **Precious-items license:** Learnt about requirement in January 2023; Questura di Latina confirmed on 2023-01-30 that only fiscal tracking (facture/record-keeping) was needed at that stage (no special deposit). Formal application submitted on **2025-03-27** via Fiscozen ([[mail-thread-28743]]). Outcome unknown.",
    "- **Precious-items license:** Learnt about requirement in January 2023; Questura di Latina confirmed on 2023-01-30 that only fiscal tracking (fatture/record-keeping) was needed at that stage (no special deposit). A formal license workflow was prepared in March 2025 via Fiscozen ([[mail-thread-28743]]), but Alessio does not want to pursue the license and UNICA is not currently active.",
  );
  text = text.replace(
    "10. **Is the domain `unica-jewelry.com` still active?** (Renewed to April 2026 per April 2025 payment – see timeline.)\n11. **Was the precious‑items license granted?**\n12. **Does the domain renewal (into 2026) indicate continued active planning or merely automatic renewal of an abandoned asset?**",
    "10. **Is the domain `unica-jewelry.com` still active?** (Renewed to April 2026 per April 2025 payment – see timeline.)\n11. **Current status:** UNICA is not active now, but remains an important historical project.\n12. **Precious-items license:** The license should be treated as not pursued; Alessio does not want to complete it unless the business is reactivated.",
  );
  text = addAfter(
    text,
    "Answer: no confirmed November 2024 launch. The best-supported status is continued planning/positioning, with formal license preparation in March 2025 and domain renewal in April 2025.\n",
    `\n## Current Status Resolution\n\nUNICA is not currently active. It should not be presented as an operating jewelry business, but it remains an important historical entrepreneurial project because it involved brand strategy, supplier negotiation, regulatory research, domain maintenance, video commissioning, and tax/business planning over multiple years.\n\nThe precious-items license workflow should be treated as stopped rather than pending: Alessio does not want to pursue the license unless the project is revived.\n`,
    "UNICA current status resolution",
  );
  write(rel, text);
}

{
  const rel = "wiki/projects/unica-jewelry.md";
  let text = setUpdated(read(rel));
  text = text.replace("status: historical", "status: historical");
  text = mustReplace(
    text,
    "**Status:** The connection is supported by the license application, earlier negotiations, and the brand-name evidence from [[mail-thread-28783]]. However, no evidence of sales or an active website has been found.",
    "**Status:** The connection is supported by the license workflow, earlier negotiations, and the brand-name evidence from [[mail-thread-28783]]. UNICA is not currently active; no evidence of sales or an active website has been found.",
    "unica domain status",
  );
  text = mustReplace(
    text,
    "- Was the precious items license granted by the questura?",
    "- The precious-items license was not pursued to completion; Alessio does not want to proceed with it while UNICA is inactive.",
    "unica domain license question",
  );
  write(rel, text);
}

{
  const rel = "wiki/topics/precious-items-license.md";
  let text = setUpdated(read(rel));
  text = addAfter(
    text,
    "The precious items license (Italian: *autorizzazione per la vendita di oggetti preziosi*, also referred to as *licenza preziosi* or *licenza di polizia*) is an administrative authorization required to legally trade in precious metals, stones, or jewelry in Italy. It is issued by the local police headquarters (Questura) and involves specific premises requirements.\n",
    `\nCurrent resolution for Alessio's case: the workflow was prepared for [[unica-brand]], but Alessio does not want to pursue the license while UNICA is inactive. Treat the application as stopped, not as a pending operational requirement.\n`,
    "precious license current resolution",
  );
  text = mustReplace(
    text,
    "- **Was the application actually submitted?** No confirmation exists in the documented sources beyond the email preparation.\n- **Was the police module issue resolved?** The status of the modulo per la licenza della questura remained unresolved as of 20 March 2025 ([[mail-thread-30938]]).\n- **Was the license granted?** No evidence available.",
    "- **Was the application actually submitted?** No confirmation exists in the documented sources beyond the email preparation.\n- **Was the police module issue resolved?** The status of the modulo per la licenza della questura remained unresolved as of 20 March 2025 ([[mail-thread-30938]]).\n- **Was the license granted?** No; the workflow should be treated as stopped/not pursued while UNICA is inactive.",
    "precious license status",
  );
  write(rel, text);
}

// CandidAI: promo video and Michele Bennati proposal ended without response.
for (const rel of ["wiki/projects/candidai-promo-video-commission.md", "wiki/experiences/candidai-promo-video-commission.md"]) {
  let text = setUpdated(read(rel));
  text = text
    .replace("The project remains stalled, and the upfront payment is at risk.", "The project died there: John did not reply after the 6 January 2026 follow-up, no delivery is documented, and the upfront $200 should be treated as lost/risk exposure rather than an active commitment.")
    .replace("**Stalled.** No delivery or further communication from John after 2026-01-06. The upfront payment is at risk.", "**Closed as stalled / no response.** No delivery or further communication from John after 2026-01-06. The upfront $200 should be treated as lost/risk exposure rather than an active commitment.");
  write(rel, text);
}

{
  const rel = "wiki/projects/candidai-project.md";
  let text = setUpdated(read(rel));
  text = text
    .replace(
      "- [[michele-bennati]] – Contacted by Alessio in December 2025 for a proposal related to the project ([[mail-thread-2727]]).",
      "- [[michele-bennati]] – Contacted by Alessio in December 2025 for a proposal related to the project ([[mail-thread-2727]]). The proposal track died there: no reply was received.",
    )
    .replace(
      "- Was the promo video ever completed?\n- What was the outcome of the collaboration with Michele Bennati?",
      "- Promo video: not completed; no reply after the 6 January 2026 follow-up.\n- Michele Bennati proposal: no reply; the track is closed as non-progressed.",
    );
  write(rel, text);
}

resolve(
  [
    "review-110",
    "review-124",
    "review-393",
    "review-396",
    "review-429",
    "review-432",
    "review-456",
    "review-483",
    "review-501",
    "review-504",
    "review-514",
    "review-587",
  ],
  {
    "review-110": "Google CSE resolved as prepared but not ultimately submitted; no rejection/offer should be recorded.",
    "review-124": "Deposit outcome clarified: Alessio's tenant deposit received; Giulia's deposit still outstanding.",
    "review-393": "GENOVI follow-up resolved at status level: Alessio deposit received; Giulia deposit outstanding.",
    "review-396": "Security deposit transfer outcome clarified with split status by beneficiary.",
    "review-429": "CandidAI promo video closed as stalled/no response after 6 Jan 2026; upfront $200 treated as risk/lost exposure.",
    "review-432": "Michele Bennati proposal track closed as no reply/no progress.",
    "review-456": "Mortgage purpose/outcome clarified: family rental-property mortgage, €94k/20y/4.1% in Sonia Marfoli's name, mostly repaid.",
    "review-483": "Precious-items license workflow resolved as not pursued while UNICA is inactive.",
    "review-501": "UNICA outcome clarified as historically important but not currently active; no production/sales/public launch confirmed.",
    "review-504": "UNICA video commission treated as part of historical project with no confirmed final delivery/use.",
    "review-514": "Graduation date clarified: degree exam scheduled for 15 Jul 2026, not yet completed as of 4 Jul 2026.",
    "review-587": "Google internship/application follow-up resolved as not ultimately applied for the later opportunity; no outcome to await.",
  },
);

console.log("Resolved user answers batch 4.");
