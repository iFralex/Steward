import fs from "node:fs";
import path from "node:path";

const root = "/Users/alessioantonucci/Second Me";
const wiki = path.join(root, "wiki");
const reviewPath = path.join(root, ".llm-wiki", "review.json");
const today = "2026-07-03";

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content);
}

function ensureIncludes(rel, needle, block, beforeHeading = null) {
  const current = read(rel);
  if (current.includes(needle)) return false;
  let next;
  if (beforeHeading && current.includes(beforeHeading)) {
    next = current.replace(beforeHeading, `${block.trim()}\n\n${beforeHeading}`);
  } else {
    next = `${current.replace(/\s*$/, "")}\n\n${block.trim()}\n`;
  }
  write(rel, next);
  return true;
}

function replaceOnce(rel, from, to) {
  const current = read(rel);
  if (!current.includes(from)) {
    throw new Error(`Pattern not found in ${rel}: ${from.slice(0, 80)}`);
  }
  write(rel, current.replace(from, to));
  return true;
}

function upsertFile(rel, content) {
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) {
    const current = fs.readFileSync(abs, "utf8");
    if (current.includes("## Review Resolution")) return false;
    fs.writeFileSync(abs, `${current.replace(/\s*$/, "")}\n\n${content.trim()}\n`);
    return true;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${content.trim()}\n`);
  return true;
}

let changed = 0;

changed += ensureIncludes(
  "wiki/people/alessio-antonucci.md",
  "Aruba remote digital signature user code",
  `
## Digital Signature Credentials

Alessio Antonucci has an Aruba remote qualified electronic signature product, **Firma Remota con Otp Mobile**, documented by the Aruba order and activation emails from 6 September 2024. The credential identifiers are:

- **Aruba username:** \`15755185@aruba.it\`
- **Aruba remote digital signature user code:** \`7KP84Y9QRJ\`
- **Nominal service term:** 36 months from the 2024-09-06 order, with expiry recorded as 2027-09-06.

The activation email in [[mail-thread-30285]] states that the activation link was valid for 12 months, so that link expired in September 2025. The user code remains useful as an identifier for the same Aruba remote-signature credential, but if activation was never completed, the credential may require Aruba support before use. See [[firma-digitale]], [[mail-thread-28709]], and [[mail-thread-30285]].
`
);

changed += replaceOnce(
  "wiki/topics/firma-digitale.md",
  "| Aruba Firma Remota | [[aruba-spa]] | 2024-09-06 (identification completed) | Qualified Electronic Signature (QES) | Product: Firma Remota con Otp Mobile, 36-month subscription, €53.56, username 15755185@aruba.it, expires 2027-09-06. Source: [[mail-thread-28708]], [[mail-thread-28709]] |",
  "| Aruba Firma Remota | [[aruba-spa]] | 2024-09-06 (identification completed) | Qualified Electronic Signature (QES) | Product: Firma Remota con Otp Mobile, 36-month subscription, €53.56, username `15755185@aruba.it`, user code `7KP84Y9QRJ`, nominal expiry 2027-09-06. The activation link in [[mail-thread-30285]] expired after 12 months, in September 2025. Sources: [[mail-thread-28708]], [[mail-thread-28709]], [[mail-thread-30285]] |"
);

changed += ensureIncludes(
  "wiki/topics/firma-digitale.md",
  "## Aruba Remote Signature Resolution",
  `
## Aruba Remote Signature Resolution

[[mail-thread-28709]] documents the Aruba order for **Firma Remota con Otp Mobile** with username \`15755185@aruba.it\`. [[mail-thread-30285]] is not a separate credential: it is the activation email for the same remote-signature product and adds the user code \`7KP84Y9QRJ\`. Because the activation link was valid for 12 months, the link itself expired in September 2025; the wiki therefore records the credential identifiers but does not assume the signature is currently usable unless activation was completed or Aruba support reactivated it.
`
);

changed += ensureIncludes(
  "wiki/experiences/web-developer-dotdotdot.md",
  "## Title Canonicalization",
  `
## Title Canonicalization

This page is preserved as the historical **Web Developer** label used in CV5/CV6-style materials and related narrative documents. The later canonical employment page is [[software-engineer-dotdotdot]], because CV4 uses **Software Engineer** and the later review selected that title as the more authoritative role label. Both pages describe the same Dotdotdot employment period, October 2024 to March 2025, not two separate jobs.
`
);

changed += ensureIncludes(
  "wiki/experiences/software-engineer-dotdotdot.md",
  "## Duplicate Resolution",
  `
## Duplicate Resolution

[[web-developer-dotdotdot]] and this page refer to the same Dotdotdot employment. The wiki keeps this page as the canonical updated title and keeps the Web Developer page as a historical-label page for source traceability.
`
);

changed += ensureIncludes(
  "wiki/sources/mail-thread-109.md",
  "## Duplicate Source Resolution",
  `
## Duplicate Source Resolution

[[mail-thread-109]] and [[mail-thread-116]] are duplicate ingestions of the same Polimi Helpdesk ticket **#101592055** from 16 June 2026. The canonical consolidated source page is [[mail-thread-116]], which records the identical ticket content and the relationship to the parallel email request to [[people/alice-murolo]]. This page is retained for provenance only.
`
);

changed += ensureIncludes(
  "wiki/sources/mail-thread-116.md",
  "## Canonical Source Resolution",
  `
## Canonical Source Resolution

This page is the canonical consolidated source for duplicate ingestions [[mail-thread-109]] and [[mail-thread-116]]. Both represent the same Polimi Helpdesk ticket **#101592055** opened on 16 June 2026. [[mail-thread-109]] is retained as a provenance alias rather than a separate event.
`
);

changed += upsertFile(
  "wiki/people/manuela-british-council.md",
  `---
type: person
title: Manuela (British Council Italy)
created: ${today}
updated: ${today}
tags: [british-council, ielts, accessibility, exam-arrangements, contact]
related: [british-council, ielts-accessibility-request-2026, alessio-antonucci]
sources: ["mail-thread-1206.md"]
organization: british-council
---
# Manuela (British Council Italy)

Manuela was the named British Council Italy contact in Alessio Antonucci's March 2026 IELTS Academic accessibility request. She handled the Special Arrangements communication, reference **CS-27830365**, and explained that IELTS on Paper required medical documentation at least six weeks before the test date.

## Review Resolution

This page is intentionally minimal because the available source documents a single contact interaction rather than an ongoing relationship. Further British Council process details remain on [[british-council]] and [[ielts-accessibility-request-2026]].`
);

changed += ensureIncludes(
  "wiki/organizations/british-council.md",
  "[[people/manuela-british-council]]",
  `
## Contact Resolution

The contact person **Manuela** is represented by the minimal person page [[people/manuela-british-council]]. The organization page remains the canonical place for the IELTS Special Arrangements process; the person page exists only to avoid an unresolved index entry.
`
);

changed += replaceOnce(
  "wiki/organizations/mesa.md",
  'related: ["politecnico-di-milano", "aleksandra-pavlovic", "alessio-antonucci", "mail-thread-4298", "mail-thread-4005", "emanuel-mihali"]sources:',
  'related: ["politecnico-di-milano", "aleksandra-pavlovic", "alessio-antonucci", "mail-thread-4298", "mail-thread-4005", "emanuel-mihali"]\nsources:'
);

changed += ensureIncludes(
  "wiki/organizations/mesa.md",
  "## Acronym Resolution",
  `
## Acronym Resolution

The local source set does not expand the acronym **MESA**. The wiki should therefore keep **MESA** as the attested organization name and avoid inferring a full expansion from search guesses. If a future source provides the formal name, update this page then.
`
);

changed += ensureIncludes(
  "wiki/people/alessandro-campi.md",
  "## Canonical Page Resolution",
  `
## Canonical Page Resolution

This page is the canonical person page for Professor Alessandro Campi. [[prof-campi]] is retained as a legacy alias page because older source-derived links used the shortened label.
`
);

changed += ensureIncludes(
  "wiki/people/prof-campi.md",
  "## Alias Resolution",
  `
## Alias Resolution

This is a legacy alias page for [[alessandro-campi]]. Future relationship links should prefer [[alessandro-campi]] as the canonical person page, while this page remains available for older references that used "Prof. Campi".
`
);

changed += ensureIncludes(
  "wiki/organizations/register-it.md",
  "## Registrar Alias Resolution",
  `
## Registrar Alias Resolution

[[register-it]] is the canonical organization page for the commercial registrar. [[register-reg]] is treated as a registrar-code alias that appeared in a domain record, not as a separate organization.
`
);

changed += ensureIncludes(
  "wiki/organizations/register-reg.md",
  "## Alias Resolution",
  `
## Alias Resolution

REGISTER-REG is treated as a registrar-code alias for [[register-it]] in the [[helmstudio-it]] domain record. It is not maintained as a separate organization; use [[register-it]] for the canonical company page and [[registro-it]] for the official .it registry.
`
);

changed += ensureIncludes(
  "wiki/projects/unica-jewelry.md",
  "## Brand/Domain Resolution",
  `
## Brand/Domain Resolution

[[unica-brand]] is the canonical project/brand entity. This page represents the domain and digital storefront component, \`unica-jewelry.com\`, within that broader brand project. No merge is needed: the brand page captures the business concept, while this page tracks domain registration, renewal, WHOIS, and infrastructure evidence.
`,
  "## Open questions"
);

changed += ensureIncludes(
  "wiki/topics/carta-freccialink.md",
  "## Duplicate Source Resolution",
  `
## Duplicate Source Resolution

[[mail-thread-29168]] is not a new CartaFRECCIA account or separate relationship. It is an October 2023 recovery email that confirms the same card code and username already attested by the August 2023 registration email. It is retained as corroborating evidence in the timeline.
`
);

for (const rel of [
  "wiki/projects/first-fps-for-blind-users.md",
  "wiki/projects/oltre-leclisse.md",
  "wiki/queries/identity-of-early-accessibility-games.md",
]) {
  changed += ensureIncludes(
    rel,
    "## Duplicate Review Resolution",
    `
## Duplicate Review Resolution

The available evidence does not prove that [[first-fps-for-blind-users]] and [[oltre-leclisse]] are the same project. The wiki therefore keeps them as separate project pages and uses [[identity-of-early-accessibility-games]] as the explicit query page for the unresolved identity relationship.
`
  );
}

for (const rel of [
  "wiki/people/riccardo-rovelli.md",
  "wiki/people/anais-tarbi.md",
  "wiki/people/rohan-taneja.md",
]) {
  changed += ensureIncludes(
    rel,
    "## Duplicate Review Resolution",
    `
## Duplicate Review Resolution

The review item for Riccardo Rovelli, Anais Tarbi, and Rohan Taneja found no actual duplicate pages in the wiki. These entries remain separate people because the sources describe distinct ST Engineering Antycip collaborators.
`
  );
}

const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
const resolutions = new Map([
  ["review-542", "Updated Alessio Antonucci page with Aruba remote signature username, user code, service term, and expired activation-link caveat."],
  ["review-543", "Updated firma-digitale page to relate mail-thread-28709 and mail-thread-30285 as the same Aruba remote-signature credential."],
  ["review-11", "Kept software-engineer-dotdotdot as canonical and web-developer-dotdotdot as historical title page."],
  ["review-142", "Kept mail-thread-116 as canonical consolidated source and mail-thread-109 as provenance alias."],
  ["review-169", "Created minimal Manuela British Council person page and linked it from British Council."],
  ["review-292", "Recorded that MESA acronym expansion is not available in local sources and should not be inferred."],
  ["review-295", "Duplicate archival source pair already documented; marked resolved."],
  ["review-302", "Duplicate archival source pair already documented; marked resolved."],
  ["review-311", "Kept alessandro-campi as canonical and prof-campi as legacy alias."],
  ["review-340", "Kept register-it as canonical registrar and register-reg as registrar-code alias."],
  ["review-493", "Documented unica-jewelry as domain/storefront component of unica-brand; no merge needed."],
  ["review-510", "Documented mail-thread-29168 as corroborating CartaFRECCIA recovery evidence, not a new account."],
  ["review-562", "Kept early accessibility game pages separate until stronger evidence appears; query page remains the relationship tracker."],
  ["review-590", "Confirmed Riccardo Rovelli, Anais Tarbi, and Rohan Taneja are distinct people with no duplicate pages."],
]);

for (const item of review) {
  if (resolutions.has(item.id)) {
    item.resolved = true;
    item.resolvedAt = new Date().toISOString();
    item.resolution = resolutions.get(item.id);
  }
}

fs.writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);

console.log(`Updated ${changed} document operations and resolved ${resolutions.size} review items.`);
