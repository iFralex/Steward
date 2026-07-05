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
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
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
  'wiki/experiences/top-tutoring-online-program.md',
  'wiki/organizations/top-tutoring-online-program.md',
]) {
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Age Range Resolution', `
The current evidence should describe Alessio's TOP tutoring as support to a **middle school student**, not high school students. The Google CSE cover letter and the updated TOP experience page align on middle-school tutoring. Any older "high school" wording should be treated as a stale/generalized description unless a separate source explicitly documents another tutoring cohort.
`);
  write(rel, md);
}

{
  const rel = 'wiki/experiences/customer-solutions-engineer-google-application.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    'The cover letter also references tutoring experience, possibly connected to [[top-tutoring-online-program]] (though with a minor age‑range discrepancy).',
    'The cover letter also references tutoring experience connected to [[top-tutoring-online-program]]. The age range is resolved as middle school tutoring; older high-school wording was a stale/generalized summary.',
  );
  md = replaceSection(md, 'Tutoring Age Range Resolution', `
The tutoring line should be represented as middle-school academic support. No separate high-school tutoring activity is required to reconcile the Google CSE cover letter with the TOP pages.
`);
  write(rel, md);
}

{
  const rel = 'wiki/topics/fondamenti-di-elettronica.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    'This course may be related to [[elettrotecnica]] or other electronics courses in the program. Further clarification is needed on its exact position in Alessio\'s study plan.',
    'This course is distinct from [[elettrotecnica]] in the wiki. Fondamenti di Elettronica is documented in the 2025/26 accommodation/tutoring sources with Professor [[giulia-acconcia]], while Elettrotecnica is a separate earlier course taught by [[daniele-linaro]]. Both belong to the broader electronics/electrical-engineering area, but they should not be merged.',
  );
  md = replaceSection(md, 'Course Identity Resolution', `
Resolved as a distinct course page. **Fondamenti di Elettronica** is tied to Professor Giulia Acconcia, Amin Oulbaz tutoring, and the January 2026 accommodation workflow. **Elettrotecnica** is tied to Professor Daniele Linaro and 2024 accommodation/exam sessions. The similar names reflect related subject matter, not duplicate wiki entities.
`);
  write(rel, md);
}

{
  const rel = 'wiki/topics/elettrotecnica.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Relationship to Fondamenti di Elettronica', `
Do not merge this page with [[fondamenti-di-elettronica]]. Elettrotecnica is documented as a separate course taught by Professor [[daniele-linaro]] in the 2024 accommodation sources. Fondamenti di Elettronica is documented later, with Professor [[giulia-acconcia]] and a January 2026 exam-accommodation workflow.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-2336.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    'The exam was scheduled for **30 January 2025** as written in the source. Given the email date of 26 January 2026 and the timing of tutoring assignments (Amin Oulbaz started 16 Oct 2025), this is almost certainly a **typographical error** and should read **30 January 2026**. The discrepancy is flagged for user verification.',
    'The exam was scheduled for **30 January 2026**. If the source text displays 2025 anywhere, that is a typographical/year-rollover error: the email date is 26 January 2026, the tutoring context began in October 2025, and the accommodation confirmation clearly belongs to the January 2026 exam session.',
  );
  md = replaceSection(md, 'Review Resolution', `
The correct exam date for wiki purposes is **30 January 2026**. The prior "2025" wording was inconsistent with the email date and surrounding 2025/26 tutoring timeline.
`);
  write(rel, md);
}

write('wiki/events/fondamenti-di-elettronica-exam-2026-01.md', `---
type: event
title: Fondamenti di Elettronica Exam (30 January 2026)
created: 2026-07-03
updated: 2026-07-03
tags: [exam, fondamenti-di-elettronica, multichance, accommodations]
related: [alessio-antonucci, giulia-acconcia, paola-bravo, amin-oulbaz, multichance, fondamenti-di-elettronica, exam-accommodations]
sources: ["mail-thread-2336.md", "mail-thread-4972.md"]
status: documented
start_date: 2026-01-30
---
# Fondamenti di Elettronica Exam (30 January 2026)

Documented exam session for [[alessio-antonucci]] in [[fondamenti-di-elettronica]] at [[politecnico-di-milano]].

## Accommodation Setup

Professor [[giulia-acconcia]] confirmed the practical accommodation setup on 26 January 2026:

- Alessio's personal iPad with assistive software (screen reader and magnification).
- Multichance tutor present to read text and graphical/numerical content.
- Alessio seated near the professor.
- 50% extra time: standard 2h30m extended to 3h30m.

## Date Resolution

The exam date is **30 January 2026**. Any "30 January 2025" wording in extracted source summaries is a typo, because the confirmation email is dated 26 January 2026 and the tutoring context is from the 2025/26 academic year.

## Relationship to Earlier January Event

[[fondamenti-di-elettronica-exam-12-january-2026]] remains a separate, uncertain accompaniment event inferred from tutor scheduling. This page is the confirmed 30 January 2026 exam-accommodation event.
`);

{
  const rel = 'wiki/topics/reti-logiche.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    'The original accommodation notification in September 2025 specified 30% extra time, but the actual exam used up to 50% extra time. This may reflect an accommodation update, flexible application by the professor, or the professor\'s discretion on exam day. The discrepancy is minor and does not contradict the documented success.',
    'The original accommodation notification in September 2025 specified 30% extra time, but the actual exam used up to 50% extra time. For this completed exam, the actual implementation documented in [[mail-thread-2420]] is authoritative. No source currently shows whether this came from a formal update, flexible implementation by Professor Fornaciari, or exam-day discretion. Future exam pages should distinguish notified entitlement from actual applied time.',
  );
  md = replaceSection(md, 'Extra Time Resolution', `
Resolved for historical purposes: the September notification documented a 30% baseline, while the January 2026 exam record documents the actual applied accommodation as up to 50%. This is an implementation variance, not a contradiction in the exam outcome.
`);
  write(rel, md);
}

for (const rel of ['wiki/topics/exam-accommodations.md', 'wiki/people/william-fornaciari.md']) {
  if (!fs.existsSync(file(rel))) continue;
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Reti Logiche Extra Time Resolution', `
For [[reti-logiche]], the September 2025 notification recorded 30% extra time, while the January 2026 exam was actually conducted with up to 50% extra time. Treat 30% as the notified baseline and 50% as the documented implementation for the completed exam. The mechanism for the increase is not extracted from current sources.
`);
  write(rel, md);
}

for (const rel of ['wiki/organizations/servizio-pari-opportunita.md', 'wiki/topics/multichance.md']) {
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Relationship Resolution', `
Treat **Servizio Pari Opportunita** as the broader/administrative Polimi equal-opportunities service label and **Multichance** as the named disability-support workflow/team used in many later accommodation records. They are closely connected in Alessio's sources and should be cross-linked, but not merged unless an official source states they are exactly the same unit.

Practical rule for the wiki: preserve the label used by each source; use [[multichance]] for the recurring accommodation/tutoring workflow, and [[servizio-pari-opportunita]] when a source explicitly uses that name.
`);
  write(rel, md);
}

markResolved(
  ['review-109', 'review-330', 'review-346', 'review-406', 'review-413'],
  {
    'review-109': 'TOP tutoring age range resolved as middle-school tutoring; older high-school wording treated as stale/generalized.',
    'review-330': 'Fondamenti di Elettronica and Elettrotecnica documented as separate courses with different professors/timelines.',
    'review-346': 'Servizio Pari Opportunita documented as broader/administrative label; Multichance as recurring disability-support workflow/team.',
    'review-406': 'Created event page for the confirmed Fondamenti di Elettronica exam on 30 Jan 2026.',
    'review-413': 'Reti Logiche 30% vs 50% resolved as notified baseline vs actual implementation.',
  },
);
