import fs from 'node:fs';
import path from 'node:path';

const root = '/Users/alessioantonucci/Second Me';
const today = '2026-07-03';

function file(rel) {
  return path.join(root, rel);
}

function read(rel) {
  return fs.readFileSync(file(rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(file(rel), content);
  console.log(`updated ${rel}`);
}

function bumpUpdated(md) {
  if (/^updated:/m.test(md)) return md.replace(/^updated:.*$/m, `updated: ${today}`);
  return md.replace(/^(created:.*)$/m, `$1\nupdated: ${today}`);
}

function replaceSection(md, heading, body) {
  const section = `## ${heading}\n\n${body.trim()}\n`;
  const pattern = new RegExp(`\\n## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`);
  if (pattern.test(md)) return md.replace(pattern, `\n${section}`);
  return `${md.trimEnd()}\n\n${section}`;
}

function markResolved(ids, note) {
  const rel = '.llm-wiki/review.json';
  const p = file(rel);
  const items = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const item of items) {
    if (!ids.includes(item.id)) continue;
    item.resolved = true;
    item.resolvedAction = 'documented-resolution';
    item.resolvedAt = today;
    item.resolutionNote = note[item.id] ?? 'Resolved and documented in the affected wiki pages.';
  }
  fs.writeFileSync(p, JSON.stringify(items, null, 2) + '\n');
  console.log(`updated ${rel}`);
}

{
  const rel = 'wiki/entities/partita-iva-of-alessio-antonucci.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Review Resolution', `
Current source-backed status:

- **Opening:** active/opened in **August 2024**, confirmed by later Fiscozen/admin sources.
- **September 2024:** Alessio was actively managing it by applying for the 35% INPS artisan/commercial contribution reduction.
- **February 2025:** Provincia di Varese / collocamento mirato instructed him to close it because an active partita IVA conflicted with protected-category jobseeker registration.
- **Closure:** no source currently confirms whether the partita IVA was actually closed.

Answer: closure status remains unknown, but the timeline is not contradictory. The VAT activity was active before the employment-placement conflict arose; the unresolved factual gap is only whether Alessio followed the February 2025 closure instruction.
`);
  write(rel, md);
}

{
  const rel = 'wiki/topics/partita-iva.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Opening Date Resolution', `
The April 2023 source documents **intent/readiness** to open a partita IVA, not a confirmed opening. The first source-backed opening/active date is **August 2024**, with active management confirmed in September 2024 through the INPS reduction request.

Use this interpretation:

- January-April 2023: planning and regulatory exploration for UNICA.
- August 2024: partita IVA opened/active.
- September 2024-January 2025: administrative maintenance and benefit/tax handling.
- February 2025: conflict with collocamento mirato; closure instructed but not confirmed.
`);
  md = replaceSection(md, 'Collocamento Mirato Conflict Resolution', `
The September 2024 INPS reduction request and the February 2025 closure instruction are sequential, not inherently incompatible. Alessio first managed the partita IVA as an active self-employment vehicle, then later encountered a protected-employment eligibility conflict when proceeding through collocamento mirato.

The missing information is whether the closure was completed after February 2025. Until a closure certificate, Fiscozen notice, Chamber of Commerce extract, or later continuation evidence appears, the status should remain **closure unknown**.
`);
  write(rel, md);
}

{
  const rel = 'wiki/topics/riduzione-inps-artigiani-commercianti.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Timeline Resolution', `
The INPS reduction request on 26 September 2024 is evidence of active partita IVA management before the later February 2025 collocamento mirato conflict. It does not conflict with the closure instruction; the instruction came later and arose from a different administrative goal: protected-category job placement.

Open factual gap: no source confirms whether the reduction was granted or whether the partita IVA was later closed.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-28782.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Earliest Evidence Resolution', `
This February 2023 thread is not the earliest evidence of the jewelry business. [[mail-thread-28783]] from 1 January 2023 predates it and documents the UNICA name, 3D-designed earrings, and outreach to Italgold. This thread remains important as the earliest detailed Essentials Jewelry production negotiation.
`);
  write(rel, md);
}

{
  const rel = 'wiki/projects/unica-brand.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    '4. **November 2024 Launch vs. March 2025 License:** The August 2024 email claims a November 2024 launch. However, a precious‑items license was still being applied for in March 2025 – this is a **strong contradiction** suggesting the launch likely did not occur as planned.',
    '4. **November 2024 launch claim:** Treat the August 2024 email as aspirational/marketing positioning. The March 2025 precious-items license application and lack of sales/production evidence indicate that no legally supported public jewelry launch is confirmed for November 2024.',
  );
  md = replaceSection(md, 'Launch and License Resolution', `
The claimed November 2024 UNICA launch should be treated as aspirational unless a later source proves actual sales, publication, or fulfillment. The March 2025 precious-items license workflow shows Alessio was still formalizing the legal ability to sell precious items months after the claimed launch date.

Answer: no confirmed November 2024 launch. The best-supported status is continued planning/positioning, with formal license preparation in March 2025 and domain renewal in April 2025.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-30180.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Review Resolution', `
The November 2024 launch statement is self-reported and forward-looking. In the absence of production, sales, published storefront, or license-grant evidence, treat it as planned/aspirational positioning rather than a confirmed launch.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-28743.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Launch Timeline Implication', `
This March 2025 license-preparation thread weakens the claim that UNICA had already launched commercially in November 2024. It supports the interpretation that regulatory/commercial readiness was still being assembled in March 2025.
`);
  write(rel, md);
}

for (const rel of [
  'wiki/events/candidai-pci-dss-certification.md',
  'wiki/organizations/nexi.md',
  'wiki/projects/candidai-project.md',
  'wiki/topics/candidai-payment-processing-history.md',
]) {
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Nexi / PCI-DSS Resolution', `
The PCI-DSS certification and the merchant-practice termination are separate layers:

- PCI-DSS / Protection Plus certification was obtained as a compliance milestone.
- Nexi practice **ZK2277VD** was then suspended on 2 December 2025 and terminated after the notice period.

Resolution: CandidAI can be described as having obtained PCI-DSS certification, but the certification was **commercially ineffective** for payment processing because the associated Nexi merchant practice was rejected/terminated. Do not describe Nexi payment processing as active after early February 2026 unless a later source confirms reinstatement or a replacement provider.
`);
  write(rel, md);
}

{
  const rel = 'wiki/people/alessio-antonucci.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Business Registration Notes', `
- Alessio planned the UNICA jewelry business from January-April 2023, but the first confirmed active partita IVA date is August 2024. The April 2023 material is planning/readiness, not proof of opening.
- The partita IVA was actively managed in September 2024 through an INPS reduction request, then became a conflict for collocamento mirato in February 2025. Closure status is not confirmed.
- UNICA's claimed November 2024 launch is not confirmed; March 2025 license preparation suggests the public/commercial launch had not been fully regularized.
- CandidAI obtained Nexi PCI-DSS compliance in November 2025, but its Nexi merchant practice was suspended on 2 December 2025 and terminated after notice.
`);
  write(rel, md);
}

markResolved(
  ['review-479', 'review-486', 'review-491', 'review-498', 'review-511', 'review-538'],
  {
    'review-479': 'Partita IVA closure status remains unknown and is now explicitly documented as the remaining gap.',
    'review-486': 'INPS reduction and later closure instruction are sequential, not incompatible; closure outcome remains unknown.',
    'review-491': 'mail-thread-28783 is documented as earliest jewelry-business evidence; mail-thread-28782 is a later production negotiation.',
    'review-498': 'April 2023 is planning/readiness; first confirmed active/opened partita IVA date is August 2024.',
    'review-511': 'PCI-DSS obtained but commercially ineffective after Nexi merchant practice suspension/termination.',
    'review-538': 'November 2024 UNICA launch treated as aspirational; March 2025 license work shows no confirmed public launch.',
  },
);
