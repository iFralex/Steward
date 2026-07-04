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
  const statusIdx = md.indexOf('\n## Status\n');
  if (statusIdx !== -1) return `${md.slice(0, statusIdx)}\n${section}${md.slice(statusIdx)}`;
  return `${md.trimEnd()}\n\n${section}`;
}

function insertBeforeHeading(md, heading, section) {
  const marker = `\n## ${heading}\n`;
  const idx = md.indexOf(marker);
  if (idx === -1) return `${md.trimEnd()}\n\n${section.trim()}\n`;
  return `${md.slice(0, idx)}\n${section.trim()}\n${md.slice(idx)}`;
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
  const rel = 'wiki/queries/unrelated-document-sonia-marfoli.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    'tags: ["unresolved", "taxonomy", "sonia-marfoli", "correction", "misclassification", "family"]',
    'tags: ["resolved", "taxonomy", "sonia-marfoli", "correction", "misclassification", "family"]',
  );
  md = replaceSection(md, 'Review Resolution', `
The "unrelated" classification is obsolete. Sonia Marfoli is not an unrelated person in the collection: she is [[alessio-antonucci]]'s mother.

The relationship is now confirmed by the dedicated [[sonia-marfoli]] page, the 2026 Stato di Famiglia, the 2026 personal data update questionnaire, and multiple administrative/medical records. The original tax certificate remains relevant as a family/household financial document, not as an accidental upload.

Answer to the open question: the document should stay in the wiki as family-related evidence. It should not be interpreted as a separate, unrelated Sonia Marfoli dossier.
`);
  md = md.replace(
    /## Remaining Uncertainty[\s\S]*?(?=\n## Action Taken)/,
    '## Remaining Uncertainty\n\nNone for the relationship status: Sonia Marfoli is confirmed as Alessio Antonucci\'s mother. The only remaining document-level limitation is that individual tax/financial PDFs should still be interpreted narrowly and not generalized beyond the facts they contain.\n\n',
  );
  write(rel, md);
}

{
  const rel = 'wiki/people/sonia-marfoli.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Review Resolution', `
The earlier contradiction about Sonia Marfoli's relationship status is resolved. The page [[unrelated-document-sonia-marfoli]] was created when a tax certificate appeared to be disconnected from Alessio's biography. Later evidence confirms the opposite: Sonia Marfoli is Alessio Antonucci's mother and part of the same household context.

Resolution: classify Sonia-related tax, identity, banking, and support documents as family/household documents connected to Alessio, while preserving their source-specific scope.
`);
  write(rel, md);
}

{
  const rel = 'wiki/people/alessio-antonucci.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Identity and Name Variants', `
- **Official identity used in documents:** Alessio Antonucci.
- **ifralex identity:** Alessio controls the ifralex accounts documented below.
- **"Alessio Sebastio" metadata variant:** [[mail-thread-10171]] lists "Alessio Sebastio" in email metadata, but the message was sent from ` + '`alessiofrancoscola@gmail.com`' + `, a known Alessio account. No source currently supports a separate person named Alessio Sebastio. Treat this as a display-name, extraction, or metadata variant, not as an official alias and not as a separate entity.
- **Fineco name mismatch:** [[mail-thread-104]] shows a banking application rejected because the contract name did not match Alessio's ID. The exact wrong name is not visible in the wiki summary, so it should not be assumed to be "Alessio Sebastio" unless a source explicitly confirms it.
`);
  md = replaceSection(md, 'Disability Attribution Note', `
Alessio's own disability and his son's disability are separate facts and should not be conflated.

- Alessio himself has severe visual impairment from congenital bilateral glaucoma and cataract, recognized as grave handicap under Law 104/1992. The INPS verbale documents visual acuity of 1/20 in the right eye and hand-motion vision in the left eye, and [[mail-thread-28727]] confirms registration/transfer in the Italian *collocamento mirato* system.
- [[alessios-son]] is separately documented as blind through the Fastweb disability-discount application in [[mail-thread-28419]].

Resolution: the wiki should describe Alessio as visually impaired/registered for disability-related supports, while also preserving the separate fact that his son is blind.
`);
  const memberships = `## Memberships and Travel Credentials

- **CartaFRECCIA / FRECCIA Card:** Alessio holds Trenitalia CartaFRECCIA code **228373066**, username **alessio.antonucci04**, registered with ` + '`ifralex.business@gmail.com`' + ` on 25 August 2023. This is documented in [[mail-thread-29107]] and summarized in [[carta-freccialink]].

`;
  if (!md.includes('## Memberships and Travel Credentials')) {
    md = insertBeforeHeading(md, 'Health and Medical Contacts', memberships);
  } else {
    md = md.replace(/\n## Memberships and Travel Credentials\n[\s\S]*?(?=\n## |$)/, `\n${memberships.trim()}\n`);
  }
  md = replaceSection(md, 'INAIL Name Discrepancy', `
[[mail-thread-12823]] contains a mismatch: the INAIL email body is addressed to Alessio Antonucci, while the subject line reads "ANTONUCCI FRANCO". Current extracted source text is insufficient to identify "Franco" as a relative, alias, middle name, or clerical error.

Resolution for now: keep the INAIL event connected to Alessio because the body addresses him, but treat "ANTONUCCI FRANCO" as an unresolved source-level label until the certificate content or a human clarification confirms who Franco is.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-10171.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Review Resolution', `
"Alessio Sebastio" is treated as a metadata/display-name variant for [[alessio-antonucci]], because the sender address is ` + '`alessiofrancoscola@gmail.com`' + `, already connected to Alessio. The wiki should not create a separate person entity from this metadata alone.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-104.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Review Resolution', `
This source confirms a FinecoBank name mismatch but does not expose the incorrect contract header. It can support the broader "name metadata can be inconsistent" pattern, but it does not prove that the wrong Fineco name was "Alessio Sebastio".
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-28419.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Attachment Label Resolution', `
The earlier summary phrasing "his blind son's ID" was too strong. The indexed attachment list shows Sonia Marfoli's ID card (` + '`carta d\'identità sonia.pdf`' + `), Alessio's tax code, Sonia's tax code, the Fastweb form, and a disability certificate. The available extracted text does not show a separate ID card for Alessio's son.

Resolution: interpret the application as Alessio submitting his son's disability certificate for the Fastweb discount, while Sonia's ID/tax-code documents support the household or administrative side of the application. The son's full identity document is not documented in the extracted attachment list.
`);
  md = md.replace(
    'The source establishes that Alessio has a blind son and that he submitted the application as part of a household benefit.',
    'The source establishes that Alessio has a blind son and that he submitted the application as part of a household benefit. It does not establish that a separate identity card for the son was attached.',
  );
  write(rel, md);
}

{
  const rel = 'wiki/people/alessios-son.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Fastweb Attachment Clarification', `
The Fastweb application documents the son's civil blindness through the disability certificate, but the listed identity-card attachment is Sonia Marfoli's ID card, not a confirmed ID for the son. Therefore the wiki should not infer the son's name, ID details, or other personal identifiers from the Fastweb attachment list.
`);
  write(rel, md);
}

{
  const rel = 'wiki/organizations/fastweb.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Application Attachment Clarification', `
For the 2023-12-16 Casa Light discount request, Alessio submitted the son's disability certificate plus household/administrative documents including Sonia Marfoli's ID and tax code. The extracted attachment list does not confirm a separate ID card for the son. The discount outcome remains unknown.
`);
  write(rel, md);
}

{
  const rel = 'wiki/queries/who-is-antonucci-franco.md';
  let md = bumpUpdated(read(rel));
  md = md.replace('tags: [open-question, inail, name-ambiguity]', 'tags: [reviewed-open-question, inail, name-ambiguity]');
  md = replaceSection(md, 'Review Resolution', `
The available extracted source does not resolve who "ANTONUCCI FRANCO" is. The body of [[mail-thread-12823]] addresses Alessio Antonucci, while the subject line contains "ANTONUCCI FRANCO". No current wiki source confirms Franco as a relative, middle name, alias, or separate claimant.

Answer: treat "ANTONUCCI FRANCO" as an unresolved source-level label, likely requiring the underlying INAIL certificate or a human clarification. Do not create a separate person page and do not merge "Franco" into Alessio's official identity without further evidence.
`);
  write(rel, md);
}

{
  const rel = 'wiki/events/inail-event-2012-03-14.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Review Resolution', `
The event remains associated with Alessio because the INAIL email body addresses him directly. The subject-line label "ANTONUCCI FRANCO" is not resolved by the currently extracted source text and should be treated as a possible clerical/source metadata issue until the certificate content is reviewed.
`);
  write(rel, md);
}

markResolved(
  ['review-65', 'review-112', 'review-462', 'review-463', 'review-466', 'review-497', 'review-507', 'review-177'],
  {
    'review-65': 'Sonia Marfoli is confirmed as Alessio Antonucci’s mother; the earlier unrelated-document classification is obsolete.',
    'review-112': '"Alessio Sebastio" is documented as a metadata/display-name variant tied to a known Alessio email address, not a separate entity.',
    'review-462': 'Fastweb attachment wording corrected: Sonia’s ID is attached; no separate son ID is confirmed in extracted attachments.',
    'review-463': 'Fastweb attachment labeling discrepancy documented across source/person/organization pages.',
    'review-466': 'Alessio’s own disability and collocamento mirato registration are now explicitly documented on the person page.',
    'review-497': 'Alessio’s visual impairment is explicitly distinguished from his son’s blindness.',
    'review-507': 'CartaFRECCIA code and username added to Alessio’s person page.',
    'review-177': 'INAIL Franco discrepancy reviewed and documented as unresolved from available extracted evidence, with interpretation guidance added.',
  },
);
