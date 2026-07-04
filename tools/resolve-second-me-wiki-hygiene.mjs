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
    item.resolutionNote = note[item.id] ?? 'Resolved and documented in the wiki.';
  }
  fs.writeFileSync(p, JSON.stringify(items, null, 2) + '\n');
  console.log(`updated ${rel}`);
}

{
  const rel = 'wiki/sources/9-documenti--43-4d33458578eeb394-antonucci-alessio-14022026--14rgn7.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Date Clarification', `
There is no date contradiction in this document. The estimate was printed/issued in Rome on **10 February 2026**, while the planned same-day admission/discharge procedure date is **14 February 2026**. The four-day gap is consistent with an estimate issued before the scheduled surgery.
`);
  write(rel, md);
}

for (const [rel, canonical, title] of [
  ['wiki/people/alberto.md', 'alberto-pasquali', 'Alberto Pasquali'],
  ['wiki/people/xuwen.md', 'xuwen-ye', 'Xuwen Ye'],
]) {
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Canonical Page', `
This short-name page is retained as a compatibility alias for [[${canonical}]]. The canonical page contains the corrected identity and timeline.

Resolution: ${title} was not only a prospective February 2024 tutor. [[mail-thread-3799]] confirms active first-semester mobility-accompaniment work in September 2023; the February 2024 reference is a later prospective/renewal context.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-3771.md';
  let md = bumpUpdated(read(rel));
  md = md.replaceAll('[[alberto]]', '[[alberto-pasquali|Alberto]]');
  md = md.replaceAll('[[xuwen]]', '[[xuwen-ye|Xuwen]]');
  md = replaceSection(md, 'Name Resolution', `
The short names in this thread refer to [[alberto-pasquali]] and [[xuwen-ye]]. This February 2024 source only documents a prospective second-semester availability check; [[mail-thread-3799]] separately confirms both as active mobility tutors from September 2023.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-3799.md';
  let md = bumpUpdated(read(rel));
  md = md.replaceAll('[[alberto]]', '[[alberto-pasquali|Alberto]]');
  md = md.replaceAll('[[xuwen]]', '[[xuwen-ye|Xuwen]]');
  write(rel, md);
}

{
  const rel = 'wiki/organizations/s-s-le-tre-stelle.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    /Alessio conducted a coordinated campaign[\s\S]*?(?:These three outreach events within a 26.day period[\s\S]*?nearly simultaneously: a Slow Food.affiliated market network, a Rome event venue, and GAS groups\.|\+?These outreach events demonstrate that Alessio was actively pursuing multiple direct-to-consumer sales channels over February-April 2026: GAS groups, a Slow Food-affiliated market network, a Rome event venue, and market participation in Nettuno\.)/,
    `Alessio conducted a coordinated campaign to establish direct-to-consumer sales channels in early 2026. The earliest documented outreach currently found is **26 February 2026**, when he contacted the GAS at [[la-citta-dell-utopia-sci-italia]] about a direct distribution relationship ([[mail-thread-1623]]). On **12 March 2026**, he contacted [[massimo]] about joining the [[mercati-della-terra]] (Farmers' Markets) network in Lazio ([[mail-thread-1569]]) and also inquired with [[citta-dell-alta-economia]] (a Rome market/event venue) ([[mail-thread-1570]]). On **14 March 2026**, he sent a detailed proposal to multiple [[gas-gruppi-di-acquisto-solidale]] groups in Rome, including a price list, delivery logistics, and promotional offers ([[mail-thread-1467]], [[mail-thread-14708]]). A further inquiry followed on **7 April 2026** regarding market participation in Nettuno ([[mail-thread-1170]], [[mail-thread-15057]]).\n\nThese outreach events demonstrate that Alessio was actively pursuing multiple direct-to-consumer sales channels over February-April 2026: GAS groups, a Slow Food-affiliated market network, a Rome event venue, and market participation in Nettuno.`,
  );
  md = replaceSection(md, 'Review Resolution', `
The earlier "first documented April 2026" statement is superseded. Current source order is:

- **26 February 2026:** first documented commercial outreach, GAS at La Citta dell'Utopia ([[mail-thread-1623]]).
- **12 March 2026:** Mercati della Terra and Citta dell'Alta Economia outreach ([[mail-thread-1569]], [[mail-thread-1570]]).
- **14 March 2026:** broader GAS proposal ([[mail-thread-1467]], [[mail-thread-14708]]).
- **7 April 2026:** Nettuno market participation inquiry ([[mail-thread-1170]], [[mail-thread-15057]]).

Answer: the first documented date is 26 February 2026; April 2026 is not the first evidence.
`);
  write(rel, md);
}

{
  const rel = 'wiki/organizations/s.s.-le-tre-stelle.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Canonical Page', `
This dotted-slug page is a legacy duplicate of [[s-s-le-tre-stelle]]. Use [[s-s-le-tre-stelle]] as the canonical organization page.

Timeline correction: the first documented commercial outreach is **26 February 2026** ([[mail-thread-1623]]), followed by 12 March 2026, 14 March 2026, and 7 April 2026 outreach events. The April 2026 market inquiry is not the earliest evidence.
`);
  write(rel, md);
}

{
  const rel = 'wiki/projects/s-s-le-tre-stelle.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    '- **14 March 2026** – Proposal sent to multiple [[gas-gruppi-di-acquisto-solidale]] groups in Rome. (Source: [[mail-thread-1570]])',
    '- **14 March 2026** – Proposal sent to multiple [[gas-gruppi-di-acquisto-solidale]] groups in Rome. (Source: [[mail-thread-1467]]; see also [[mail-thread-14708]])',
  );
  md = replaceSection(md, 'Review Resolution', `
The project page confirms the earliest currently documented outreach as **26 February 2026** via [[mail-thread-1623]]. This supersedes older summaries that treated March or April 2026 as the first evidence.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-3803.md';
  let md = bumpUpdated(read(rel));
  md = md.replace('related: [silvia-sbattella, multichance, alessio-antonucci, accompagnamento]', 'related: [silvia-sbattella, multichance, alessio-antonucci, accompagnamento, mail-thread-4006]');
  md = replaceSection(md, 'Archival Duplicate Note', `
[[mail-thread-4006]] is an alternate archival copy of this same September 2023 feedback thread. Keep both source pages for provenance, but treat [[mail-thread-3803]] as the canonical summary and [[mail-thread-4006]] as the alternate copy.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-4006.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Archival Duplicate Note', `
This page is retained as an alternate archival copy of [[mail-thread-3803]]. It should not be interpreted as a separate event or second interaction.
`);
  write(rel, md);
}

{
  const rel = 'wiki/index.md';
  let md = bumpUpdated(read(rel));
  if (!md.includes('[[identity-of-early-accessibility-games]]')) {
    md = md.replace(
      '- [[identity-of-bread-game-requesters]] — Whether camperozzo and IFralex are the same person, collaborators, or unrelated. Now partially resolved: IFralex confirmed as Alessio; camperozzo remains a distinct client.',
      `- [[identity-of-bread-game-requesters]] — Whether camperozzo and IFralex are the same person, collaborators, or unrelated. Now partially resolved: IFralex confirmed as Alessio; camperozzo remains a distinct client.
- [[identity-of-early-accessibility-games]] — Whether Oltre l'eclisse, the first FPS for blind users, the accessible Fortnite concept, and the 2019 paid game plan are the same project or related but distinct efforts.`,
    );
  }
  write(rel, md);
}

markResolved(
  ['review-81', 'review-195', 'review-197', 'review-262', 'review-298', 'review-595'],
  {
    'review-81': 'Date sequence documented as consistent: estimate issued 10 Feb 2026 for planned 14 Feb 2026 procedure.',
    'review-195': 'Index entry for Alessio is already concise relative to the person page; no further duplication issue remains.',
    'review-197': 'Le Tre Stelle timeline corrected: first documented outreach is 26 Feb 2026, with March/April as later events.',
    'review-262': 'Alberto/Xuwen short slugs retained as compatibility aliases; canonical pages document active Sep 2023 tutoring.',
    'review-298': 'mail-thread-3803/4006 documented as canonical plus alternate archival copy, not separate events.',
    'review-595': 'Index now links identity-of-early-accessibility-games separately from identity-of-bread-game-requesters.',
  },
);
