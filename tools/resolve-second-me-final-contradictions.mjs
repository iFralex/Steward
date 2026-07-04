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

for (const rel of [
  'wiki/sources/8-carriera--7-lettere--23-reference-letter-sciuto--hnoijl.md',
  'wiki/sources/8-carriera--7-lettere--29-reference-letter-sciuto-draft--9bviif.md',
  'wiki/sources/8-carriera--7-lettere--51-reference-letter-antonucci-alessio-bending-spoons--17lso52.md',
  'wiki/experiences/bending-spoons-employability-scholarship-application-2025.md',
  'wiki/organizations/bending-spoons.md',
]) {
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Reference Letter Relationship Resolution', `
There are two letter groups, not one duplicate document:

- **Sciuto letter:** a complete university reference from Prof. Donatella Sciuto supporting Alessio's Bending Spoons EmployAbility scholarship application. A draft and a final signed version exist.
- **Bending Spoons-titled letter:** an incomplete recovered source with only the header/body missing. It should not be treated as proof of employment, contract work, or a completed endorsement from Bending Spoons.

Best interpretation: both belong to the same broad Bending Spoons scholarship/application dossier, but the incomplete Bending Spoons-titled file cannot establish a separate affiliation or timeline.
`);
  write(rel, md);
}

for (const rel of ['wiki/entities/rasta-guide-dog.md', 'wiki/events/guide-dog-command-list-2021.md']) {
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Delivery Class Resolution', `
Rasta remains the only named/confirmed guide dog in the wiki. The July 2021 delivery-class command list is plausibly part of the same guide-dog process, but the source does not name Rasta. Therefore:

- do not create a second guide-dog entity from this source alone;
- do not state as fact that the July 2021 class was for Rasta;
- describe it as preparatory/possibly related to Rasta until a source names the dog or confirms the pairing date.
`);
  write(rel, md);
}

{
  const rel = 'wiki/people/marie-ballut.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Relationship Context Resolution', `
The available source only shows that Alessio reviewed Marie Ballut's CV and asked about her job-search preferences. It does not establish whether the relationship was academic, professional, personal, or a referral.

Answer: keep Marie Ballut as a minimal contact/job-search page and do not infer a stronger relationship without additional correspondence.
`);
  write(rel, md);
}

for (const rel of ['wiki/people/paola-bravo.md', 'wiki/sources/mail-thread-4278.md']) {
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Paolo / Paola Bravo Resolution', `
Treat **"Paolo Bravo"** in [[mail-thread-4278]] as a likely source typo or display-name variant for [[paola-bravo]]. The email role, MultiChancePoliTeam context, accommodation workflow, and surrounding sources all align with Paola Bravo's documented responsibilities. No separate Paolo Bravo entity should be created unless a future source provides independent evidence.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-28378.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    'The email was sent from Alessio\'s secondary Gmail address `alessiofrancoscuola@gmail.com` with the display name "1000 tutorial, facili e divertenti". The relationship between Alessio and Sonia Marfoli is unspecified in this source. The original forwarded document is not visible in the source summary.',
    'The email was sent from Alessio\'s secondary Gmail address `alessiofrancoscuola@gmail.com` with the display name "1000 tutorial, facili e divertenti". Later sources confirm Sonia Marfoli is Alessio\'s mother; this thread is therefore part of Alessio handling family financial/tax documentation. The display name appears to be a reused or legacy account label and should not override the sender identity established by the email address and surrounding records. The original forwarded document is not visible in the source summary.',
  );
  md = replaceSection(md, 'Display Name Resolution', `
The display name "1000 tutorial, facili e divertenti" is a legacy/reused account label on Alessio's secondary Gmail account. It does not indicate a different sender or unrelated content. Treat the sender as Alessio Antonucci forwarding Sonia Marfoli's CUD in a family/banking administration context.
`);
  write(rel, md);
}

for (const rel of [
  'wiki/topics/collocamento-mirato.md',
  'wiki/sources/mail-thread-28740.md',
  'wiki/sources/mail-thread-28730.md',
  'wiki/sources/mail-thread-28727.md',
]) {
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Varese / Milan Jurisdiction Resolution', `
Resolve the Varese/Milan question as a procedural sequence rather than a contradiction:

1. Alessio was initially registered through Latina.
2. In November 2024 he asked Milan/Afol Metropolitana to transfer the registration because of a concrete job offer.
3. In February 2025 the Varese contact handled document/eligibility issues for the ST Engineering Antycip placement and flagged the partita IVA conflict.
4. On 4 March 2025 Milan/Afol Metropolitana confirmed completion of Alessio's protected-category registration.

The Milan completion is the confirmed final registration milestone. The sources do not prove whether the November job offer was already ST Engineering Antycip or whether Varese acted as a parallel/intermediate office for the same placement.
`);
  write(rel, md);
}

for (const rel of [
  'wiki/people/alessio-antonucci.md',
  'wiki/overview.md',
  'wiki/topics/disability-transport-accommodations.md',
  'wiki/topics/transport-benefits-polimi.md',
]) {
  if (!fs.existsSync(file(rel))) continue;
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Residence / Transport Status Resolution', `
University housing and legal/regional residence are separate statuses. Alessio can be a Polimi residence occupant or "fuori sede" student while still not having transferred legal residence to Milan/Lombardy. Therefore the transport-discount barrier for non-residents does not contradict later evidence that he lived in Polimi housing.

Answer: treat Residenza Leonardo/Marie Curie as university accommodation evidence, not as proof of legal Lombardy residence. No appeal/outcome for the transport discount is documented.
`);
  write(rel, md);
}

for (const rel of [
  'wiki/queries/identity-of-early-accessibility-games.md',
  'wiki/projects/oltre-leclisse.md',
  'wiki/projects/first-fps-for-blind-users.md',
]) {
  let md = bumpUpdated(read(rel));
  md = md.replace('unresolved]', 'reviewed]');
  md = md.replace('**Unresolved.** The question requires further sources to determine whether these projects are the same game under different names or distinct efforts. The most plausible interpretation is that Alessio worked on several related but distinct projects, with "Oltre l\'eclisse" being the final, successfully published version.', '**Reviewed resolution.** Do not merge the pages. The safest representation is that Alessio worked on related accessibility-game efforts, with "Oltre l\'eclisse" as the confirmed published/canonical title and "first-fps-for-blind-users" as an earlier unnamed prototype or possible predecessor. The exact identity remains unproven, but wiki navigation should preserve separate pages linked through this query.');
  md = replaceSection(md, 'Review Resolution', `
Decision for the wiki: keep [[oltre-leclisse]] and [[first-fps-for-blind-users]] as separate pages. [[oltre-leclisse]] is the confirmed published game. [[first-fps-for-blind-users]] is an earlier unnamed Unity/Photon FPS effort that may be the same codebase, a prototype, or a predecessor, but the source does not prove identity.
`);
  write(rel, md);
}

markResolved(
  ['review-57', 'review-126', 'review-307', 'review-320', 'review-342', 'review-446', 'review-450', 'review-481', 'review-563'],
  {
    'review-57': 'Sciuto letter and incomplete Bending Spoons-titled letter documented as related dossier items but not duplicate proof of affiliation.',
    'review-126': 'Rasta remains sole confirmed guide dog; July 2021 delivery class plausibly related but not proven.',
    'review-307': 'Marie Ballut remains a minimal CV/job-search contact; relationship context unknown.',
    'review-320': 'Paolo Bravo treated as typo/display variant for Paola Bravo; no separate entity created.',
    'review-342': 'University housing/fuori sede status distinguished from legal/regional residence for transport benefits.',
    'review-446': '1000 tutorial display name treated as legacy/reused label on Alessio secondary Gmail account.',
    'review-450': 'Same display-name mismatch resolved as account-label issue, not separate sender identity.',
    'review-481': 'Varese/Milan collocamento issue resolved as procedural sequence ending with Milan completion on 4 Mar 2025.',
    'review-563': 'Early accessibility games kept separate: Oltre l eclisse canonical published game; first FPS possible prototype/predecessor.',
  },
);
