import fs from "node:fs";
import path from "node:path";

const root = "/Users/alessioantonucci/Second Me";
const reviewPath = path.join(root, ".llm-wiki", "review.json");
const today = "2026-07-03";

function abs(rel) {
  return path.join(root, rel);
}

function writeNew(rel, body) {
  const file = abs(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, "utf8");
    if (current.includes("## Review Resolution")) return false;
    fs.writeFileSync(file, `${current.replace(/\s*$/, "")}\n\n${body.trim()}\n`);
    return true;
  }
  fs.writeFileSync(file, `${body.trim()}\n`);
  return true;
}

function page(type, title, tags, related, sources, body, extra = "") {
  return `---
type: ${type}
title: ${title}
created: ${today}
updated: ${today}
tags: [${tags.join(", ")}]
related: [${related.join(", ")}]
sources: [${sources.map((s) => `"${s}"`).join(", ")}]
${extra}---
# ${title}

${body.trim()}

## Review Resolution

This page was created to resolve the missing-page review item. It records only what is supported by the current local wiki/source set and explicitly preserves unknowns instead of inferring missing facts.`;
}

const pages = [
  ["wiki/organizations/google-translate.md", page("organization", "Google Translate", ["translation", "service", "google", "candidai"], ["candidai-project", "translation"], ["progetti/project-candidai.md"], "Google Translate is referenced as a service used by [[candidai-project]] for translation, specifically through a Firebase/API-key integration. The current source only supports the role of Google Translate as an integrated translation service; it does not document account ownership, billing, or production usage details.")],
  ["wiki/skills/translation.md", page("skill", "Translation", ["language", "translation", "candidai"], ["candidai-project", "google-translate"], ["progetti/project-candidai.md"], "Translation appears as a capability in [[candidai-project]], where Google Translate is mentioned as the service backing translation functionality. No broader language-learning or professional translation history is inferred from this single source.")],
  ["wiki/queries/education-progress-clarification.md", page("query", "Education Progress Clarification", ["education", "cv", "open-question"], ["alessio-antonucci", "politecnico-di-milano"], ["carriera/cv-storici/CV 5.pdf"], "CV 5 describes Alessio as being in a \"2/3 year bachelor's degree\". The phrase is ambiguous: it may mean second year of a three-year degree, or roughly two-thirds completed. The current local sources do not provide a transcript or a more precise academic-progress marker for that CV snapshot.")],
  ["wiki/topics/team-management-leadership.md", page("topic", "Team Management and Leadership", ["leadership", "team-management", "cv", "st-engineering-antycip"], ["alessio-antonucci", "ai-integration-military-simulation", "st-engineering-antycip"], ["carriera/cv-storici/cv8.pdf"], "CV8 states that Alessio managed or coordinated a team of five people across three countries. This page aggregates that leadership claim as a retrieval point, while keeping the exact team composition and project scope tied to the original CV evidence until further sources expand it.")],
  ["wiki/topics/health-insurance-coverage.md", page("topic", "Health Insurance Coverage", ["health", "insurance", "finance", "open-question"], ["alessio-antonucci"], ["documenti/4d33458578eeb394-ANTONUCCI-ALESSIO-14.02.2026.pdf"], "A medical-procedure document references both an insured-patient deductible and a self-paying deposit. The current evidence does not establish whether Alessio had private insurance for that procedure or whether the insured-patient language is part of a generic clinic template.")],
  ["wiki/people/francesco-vangi.md", page("person", "Francesco Vangi", ["notary", "property", "via-delle-orchidee-2"], ["via-delle-orchidee-2", "alessio-antonucci"], ["documenti/cde68c9e2c2e1f2c-DOC_1918124433.pdf"], "Francesco Vangi is the notary referenced in the documentation for the 2020 purchase of [[via-delle-orchidee-2]]. No biographical or ongoing relationship details are documented beyond his notarial role in the property records.")],
  ["wiki/people/andrea-marrocco.md", page("person", "Andrea Marrocco", ["professor", "geometry", "polimi"], ["alessio-antonucci", "politecnico-di-milano"], ["mail-thread-1095.md"], "Andrea Marrocco is mentioned as a professor/contact for a geometry problem. The current evidence supports a faculty-contact relationship only; no broader biography or course history is inferred.")],
  ["wiki/organizations/ups.md", page("organization", "UPS", ["shipping", "service-provider", "minor-organization"], ["alessio-antonucci"], ["mail-thread-11466.md"], "UPS appears as a one-off shipping or logistics service provider in the local source set. There is no evidence of an ongoing relationship, so this page is intentionally minimal.")],
  ["wiki/events/guide-dog-delivery-class-2021.md", page("event", "Guide Dog Delivery Class 2021", ["guide-dog", "rasta", "accessibility", "open-question"], ["alessio-antonucci", "rasta"], ["mail-thread-11533.md"], "The source mentions a guide-dog delivery class: the transition/training period when Rasta was handed over to Alessio. The exact dates, location, trainers, and outcome details are not present in the currently indexed source.")],
  ["wiki/queries/citta-virtuosa-consortium.md", page("query", "Citta Virtuosa Consortium", ["agriculture", "consortium", "open-question"], ["ss-le-tre-stelle"], ["mail-thread-1170.md"], "The email address `cittavirtuosa@gmail.com` appears as a consortium contact connected to [[ss-le-tre-stelle]]. The current wiki sources do not prove the formal organization name, legal entity, or relationship to markets in Lazio.")],
  ["wiki/topics/integrated-biological-control.md", page("topic", "Integrated Biological Control", ["agriculture", "farming", "concept"], ["ss-le-tre-stelle"], ["mail-thread-1170.md"], "Integrated biological control is mentioned as the farming approach associated with [[ss-le-tre-stelle]]. This page records the concept as used in that source, without expanding it into a general agronomy article beyond the local evidence.")],
  ["wiki/people/irid-domnori.md", page("person", "Irid Domnori", ["person", "email-contact", "peripheral"], ["alessio-antonucci"], ["mail-thread-11890.md"], "Irid Domnori appears as the sender of [[mail-thread-11890]] using `superiridthebest@hotmail.it`. The current source set does not establish a recurring relationship or additional identity details.")],
  ["wiki/projects/giochi-per-ciechi-website.md", page("project", "giochi-per-ciechi Website", ["accessibility", "games", "website", "blind-users"], ["alessio-antonucci", "first-fps-for-blind-users", "oltre-leclisse"], ["mail-thread-11890.md"], "The website `https://giochi-per-ciechi.jimdofree.com/` is referenced as an artifact connected to Alessio's early blind-accessible games work. The current local source records the URL, but not a complete copy of the site content.")],
  ["wiki/sources/verbale-definitivo.md", page("source", "Verbale definitivo", ["legge-104", "disability", "certification", "source"], ["alessio-antonucci", "ielts-accessibility-request-2026"], ["mail-thread-1206.md"], "`Verbale definitivo.pdf` is referenced as a Legge 104 certification attachment. The file is important supporting evidence for disability/accommodation requests, but its full extracted contents are not separately available in the current wiki page set.")],
  ["wiki/topics/a-major-scale.md", page("topic", "A Major Scale", ["music", "music-theory", "deferred"], ["alessio-antonucci"], ["mail-thread-12626.md"], "A single source references music education involving the A major scale. This is not enough to infer a broader music-history topic for Alessio, but the page records the mention for future consolidation if more music sources appear.")],
  ["wiki/queries/school-for-2019-lab-reports.md", page("query", "School for 2019 Lab Reports", ["school", "open-question", "paolo-capotosto"], ["paolo-capotosto", "alessio-antonucci"], ["mail-thread-13028.md"], "The school or institution connected to the February 2019 lab reports is not identified. The address `alessiofrancoscuola@gmail.com` may suggest continuity with later school interactions, but the current evidence does not confirm the institution.")],
  ["wiki/events/steantycip-hosting-credentials-2026.md", page("event", "ST Engineering Antycip Hosting Credentials Receipt 2026", ["st-engineering-antycip", "hosting", "credentials", "website"], ["st-engineering-antycip", "alessio-antonucci", "antycip-website-project"], ["mail-thread-1369.md"], "On 28 January 2026, Alessio received hosting credentials related to ST Engineering Antycip website work. This event page exists to make the credential handoff retrievable as part of the website project timeline.")],
  ["wiki/people/rosella-boldrini.md", page("person", "Rosella Boldrini", ["gas", "food-network", "peripheral"], ["alessio-antonucci"], ["mail-thread-1467.md"], "Rosella Boldrini appears as a GAS/contact-group person in [[mail-thread-1467]]. No recurring relationship is documented in the current source set.")],
  ["wiki/people/valentina-renzi.md", page("person", "Valentina Renzi", ["gas", "food-network", "peripheral"], ["alessio-antonucci"], ["mail-thread-1467.md"], "Valentina Renzi appears as a GAS/contact-group person in [[mail-thread-1467]]. No recurring relationship is documented in the current source set.")],
  ["wiki/sources/contexts.md", page("source", "contexts.md Attachment", ["attachment", "a11y-mirage", "source-review"], ["a11y-mirage"], ["mail-thread-1556.md"], "The source thread includes an attachment named `contexts.md`. Its content was not extracted into the wiki, so this page tracks the missing attachment review and marks it as a future enrichment point for [[a11y-mirage]].")],
  ["wiki/topics/space-and-astronomy-interest.md", page("topic", "Space and Astronomy Interest", ["space", "astronomy", "interest", "deferred"], ["alessio-antonucci"], ["mail-thread-16982.md"], "The Mars 2020 rover-name submission is a single data point suggesting interest in space or astronomy. The current evidence is too thin to describe a sustained interest, so this page remains a lightweight retrieval node.")],
  ["wiki/people/cugola.md", page("person", "Cugola", ["professor", "polimi", "peripheral"], ["politecnico-di-milano", "alessio-antonucci"], ["mail-thread-1705.md"], "Professor Cugola is referenced in a single Polimi-related email thread. The current source does not provide first name, course role, or a recurring interaction with Alessio.")],
  ["wiki/people/margara.md", page("person", "Margara", ["professor", "polimi", "peripheral"], ["politecnico-di-milano", "alessio-antonucci"], ["mail-thread-1705.md"], "Professor Margara is referenced in a single Polimi-related email thread. The current source does not provide first name, course role, or a recurring interaction with Alessio.")],
  ["wiki/topics/multichance-notification-template.md", page("topic", "Multichance Notification Template", ["multichance", "exam-accommodations", "template", "polimi"], ["multichance", "exam-accommodations", "alessio-antonucci"], ["mail-thread-3846.md", "mail-thread-3842.md", "mail-thread-3747.md"], "Multiple Multichance notification threads follow a standardized structure: identify the student, notify the professor of disability/accommodation requirements, list exam logistics, and instruct Alessio to contact the professor directly for operational arrangements. This page records the template pattern for consistency checks.")],
  ["wiki/synthesis/job-search-2026.md", page("synthesis", "Job Search 2026", ["job-search", "career", "synthesis", "2026"], ["alessio-antonucci", "st-engineering-antycip", "dotdotdot", "eit-digital-master-school"], ["mail-thread-418.md"], "This synthesis page aggregates 2026 professional-outreach evidence. It should connect ST Engineering employment continuity, Dotdotdot history, EIT Digital application materials, CV reviews, and cold outreach as more sources are resolved.")],
  ["wiki/people/ludovica-piro.md", page("person", "Ludovica Piro", ["polimi", "hci", "peripheral"], ["alessio-antonucci", "politecnico-di-milano"], ["mail-thread-4907.md"], "Ludovica Piro appears as a cc recipient or project-related contact in a single source. The current evidence does not establish a recurring relationship or precise project role.")],
  ["wiki/topics/assistive-technology.md", page("topic", "Assistive Technology", ["accessibility", "assistive-technology", "ipad", "screen-reader"], ["alessio-antonucci", "exam-accommodations"], ["mail-thread-51.md"], "The accommodation source mentions an iPad with special software, but does not name the apps. This topic page tracks the known assistive-technology ecosystem while preserving the software-name gap as unresolved.")],
  ["wiki/topics/job-applications-2025.md", page("topic", "Job Applications 2025", ["job-applications", "career", "2025"], ["alessio-antonucci", "aeonvis", "st-engineering-antycip"], ["mail-thread-5131.md"], "This topic page collects job-application activity around 2025. The current source set includes the Aeonvis interview and related career movement; future applications can be linked here without overloading individual source pages.")],
  ["wiki/topics/banking.md", page("topic", "Banking", ["banking", "finance", "accounts"], ["alessio-antonucci", "mooney", "bnl"], ["mail-thread-5434.md"], "This topic consolidates Alessio's banking and payment-service interactions, including Mooney and BNL where documented. The page is intentionally broad because the current evidence is scattered across financial-service source pages.")],
  ["wiki/topics/braille-community.md", page("topic", "Braille Community", ["braille", "accessibility", "community"], ["alessio-antonucci"], ["mail-thread-23002.md"], "The 2021 source suggests Alessio participated in an Italian braille-user community. The current evidence does not identify a formal organization, forum name, or recurring contacts, so this page records the community involvement at a high level.")],
  ["wiki/topics/jml.md", page("topic", "JML", ["java", "formal-methods", "coursework", "jml"], ["jml-stream-exam-policy", "alessio-antonucci"], ["mail-thread-2563.md"], "JML, the Java Modeling Language, is relevant to Alessio's coursework and exam policy materials. This page links JML as the concept node while detailed exam-specific rules remain on [[jml-stream-exam-policy]].")],
  ["wiki/organizations/ferramenta-grotta-irpina.md", page("organization", "Ferramenta Grotta Irpina", ["hardware-store", "minor-organization", "peripheral"], ["alessio-antonucci"], ["mail-thread-28418.md"], "The recipient `ferramenta.grotta@irpina.com` appears to be a hardware/tool business contact. The current local sources do not confirm the legal name, address, or relationship beyond this peripheral email contact.")],
  ["wiki/queries/job-offer-november-2024.md", page("query", "Job Offer November 2024", ["job-offer", "collocamento-mirato", "open-question"], ["alessio-antonucci", "collocamento-mirato"], ["mail-thread-28727.md"], "A November 2024 job offer appears to have triggered a collocamento mirato registration transfer, but the employer is not named in the current source. This query page tracks that missing employment-history link.")],
  ["wiki/queries/visual-disability-type.md", page("query", "Visual Disability Type", ["disability", "accessibility", "open-question"], ["alessio-antonucci"], ["mail-thread-28733.md", "mail-thread-28385.md"], "Sources describe Alessio as partially blind or severely visually impaired, but do not link the formal classification to a specific medical condition. The wiki should preserve the functional/legal descriptions without guessing a diagnosis.")],
  ["wiki/topics/rfi-salablu.md", page("topic", "RFI SalaBlu", ["rail", "accessibility", "assistance", "rfi"], ["rfi", "travel-assistance-request-april-2025", "alessio-antonucci"], ["mail-thread-28733.md"], "SalaBlu is the RFI assistance service relevant to rail travel for passengers with disabilities. The current local wiki mentions it through travel-assistance context; this page separates the service node from the broader [[rfi]] organization page.")],
  ["wiki/people/roberta-allievi.md", page("person", "Roberta Allievi", ["person", "contact", "peripheral"], ["alessio-antonucci"], ["mail-thread-28740.md"], "Roberta Allievi is referenced in [[mail-thread-28740]]. The current source supports creating a contact page, but does not provide enough context to infer a role beyond that thread.")],
  ["wiki/queries/giovanna-gardi-visit-outcome.md", page("query", "Giovanna Gardi Visit Outcome", ["dotdotdot", "relationship", "open-question"], ["giovanna-gardi", "alessio-antonucci", "dotdotdot"], ["mail-thread-28752.md"], "In April 2025, Alessio planned to visit Giovanna Gardi in the following months. No currently indexed source confirms whether the visit happened, so this remains an open relationship/timeline query.")],
  ["wiki/queries/unica-brand-entity-type.md", page("query", "UNICA Brand Entity Type", ["unica", "brand", "business", "schema"], ["unica-brand", "unica-jewelry"], ["mail-thread-28783.md"], "The wiki currently treats [[unica-brand]] as a project/brand entity rather than an organization. That is appropriate for the current evidence; if the brand develops into a formal business entity, it may later warrant an organization page.")],
  ["wiki/organizations/imperial-college-london.md", page("organization", "Imperial College London", ["university", "london", "peripheral"], ["federico-nardi", "alessio-antonucci"], ["mail-thread-29340.md"], "Imperial College London appears as Federico Nardi's affiliation in a LinkedIn/contact context. The current source does not document a direct institutional interaction between Alessio and Imperial.")],
  ["wiki/organizations/studio-legale-cicchitti.md", page("organization", "Studio Legale Cicchitti", ["law-firm", "legal", "organization"], ["mascia-cicchitti", "consilium-legal", "alessio-antonucci"], ["mail-thread-29756.md"], "Studio Legale Cicchitti is mentioned as Mascia Cicchitti's legal firm. The current source supports the organization name but not a detailed institutional profile.")],
  ["wiki/organizations/consilium-legal.md", page("organization", "Consilium Legal", ["legal", "organization", "network"], ["mascia-cicchitti", "studio-legale-cicchitti", "alessio-antonucci"], ["mail-thread-29756.md"], "Consilium Legal appears in Mascia Cicchitti's signature. The current source does not clarify whether it is a formal firm, network, or brand, so the page records the entity without further classification.")],
  ["wiki/events/trenitalia-account-recovery-2024.md", page("event", "Trenitalia Account Recovery 2024", ["trenitalia", "cartafreccia", "account-recovery"], ["carta-freccialink", "trenitalia", "alessio-antonucci"], ["mail-thread-30057.md"], "The 2024 Trenitalia recovery email reconfirmed the existing CartaFRECCIA code and username. It is not a new account event; it is retained as corroborating account-maintenance evidence.")],
  ["wiki/people/dilmervst.md", page("person", "dilmervst", ["developer", "code-signing", "peripheral"], ["alessio-antonucci"], ["mail-thread-32475.md"], "The user `dilmervst` is a developer/contact Alessio approached for code-signing help. The current source does not provide a real name or ongoing relationship.")],
  ["wiki/queries/matteo-michelini-response.md", page("query", "Matteo Michelini Response", ["meta", "career", "cold-outreach", "open-question"], ["matteo-michelini", "alessio-antonucci"], ["mail-thread-3275.md"], "Alessio contacted Matteo Michelini in a career/Meta-related cold outreach. The current source does not show whether Matteo replied, whether a meeting happened, or whether the outreach led to an opportunity.")],
  ["wiki/organizations/google-cloud-italy-srl.md", page("organization", "Google Cloud Italy S.r.l.", ["google-cloud", "invoice", "organization"], ["google-cloud", "alessio-antonucci"], ["mail-thread-37597.md"], "Google Cloud Italy S.r.l. appears as the issuer of an invoice in the local source set. This page records the invoicing entity but does not infer broader contractual details beyond the invoice evidence.")],
];

let changed = 0;
for (const [rel, content] of pages) {
  changed += writeNew(rel, content) ? 1 : 0;
}

const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
const ids = [
  "review-4", "review-16", "review-31", "review-79", "review-103", "review-118", "review-136", "review-139", "review-144", "review-145",
  "review-161", "review-162", "review-171", "review-176", "review-179", "review-188", "review-198", "review-215", "review-227", "review-228",
  "review-271", "review-315", "review-327", "review-345", "review-352", "review-362", "review-401", "review-423", "review-461", "review-467",
  "review-471", "review-472", "review-476", "review-488", "review-492", "review-516", "review-526", "review-527", "review-530", "review-561",
  "review-580", "review-581", "review-607",
];
for (const item of review) {
  if (ids.includes(item.id)) {
    item.resolved = true;
    item.resolvedAt = new Date().toISOString();
    item.resolution = "Created a minimal page, query page, or explicit no-inference decision page for the missing-page item.";
  }
}
fs.writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);

console.log(`Created or updated ${changed} pages and resolved ${ids.length} missing-page items.`);
