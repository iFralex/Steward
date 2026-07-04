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
  const rel = 'wiki/experiences/double-degree-masters.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    /## Programme Naming Discrepancy[\s\S]*?(?=\n## Comparison and Open Questions)/,
    `## Programme Naming Resolution

The KTH/EIT route and the XJTU route should be represented as **sequential alternatives**, not as one unresolved programme name.

- **Confirmed/current path:** EIT Digital Master School, Cloud and Networking Infrastructure and HPC / HPC at Polimi with KTH as planned exit university.
- **Exploratory/dropped path:** XJTU / Xi'an Summer Camp option described as "High Performance Computing Engineering" in the China cover letter.

The naming difference is therefore not a live contradiction in Alessio's current plan. It reflects different programme/partner contexts inside the broader HPC domain. No merge is needed unless a future official source says the XJTU-labelled programme is formally the same administrative track as EIT Digital CNIHPC.

`,
  );
  md = md.replace(
    /2\. Is the “High Performance Computing Engineering” programme the same as the EIT Digital CNIHPC programme, or a different track\?\n/,
    '',
  );
  md = replaceSection(md, 'Review Resolution', `
Resolved as a sequential-plan issue: XJTU was an evaluated option for the Xi'an Summer Camp / China route, while KTH/EIT Digital is the confirmed plan as of the latest sources. The page should keep both for historical context but not present them as equally current options.
`);
  write(rel, md);
}

{
  const rel = 'wiki/experiences/eit-digital-registration-fee-2026.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    /### Registration Fee – Detailed Information[\s\S]*?(?=\n### Tuition Fee Exemption)/,
    `### Registration Fee - Detailed Information

- **Amount:** €250, non-refundable, credited toward the first tuition fee invoice.
- **Operational resolution:** The registration fee was already paid by the time of the formal acceptance/welcome flow. The 2 April acceptance source states it as paid; the 5 April welcome email says acceptance followed payment; and the 23 April invoice states the amount was already paid before the invoice date.
- **Invoice:** Issued 23 April 2026 (reference RF26/0050 - 262048), acting as an after-the-fact invoice/receipt for an already-paid fee rather than evidence that payment occurred on 23 April.
- **Exact payment date:** Not extracted from current sources. The safest statement is **paid on or before 2 April 2026**, because the 2 April acceptance source already records it as paid.
- **Deadline interpretation:** The "deadline already passed" wording concerns the registration-fee phase, not the later tuition-deadline dates. The May/June/July dates are tuition-payment schedule options listed in the welcome email; they are separate from the registration-fee payment, and later sources document full tuition exemption.
- **Bank account details:** IBAN BE59 7340 4241 9826 - SWIFT KREDBEBB - KBC Bank NV. Account holder: "28DIGITAL Education Foundation".

`,
  );
  md = md.replace(
    '1. **Fee resolution:** Was the registration fee paid, waived, or granted an extension? The available sources give conflicting answers.\n',
    '',
  );
  md = replaceSection(md, 'English Certification Resolution', `
There is no longer a contradiction between the February alternative pathway and the March IELTS accessibility request. The sequence is:

- **Before 11 February 2026:** application submitted using the alternative English pathway recommended by Federico Schiepatti: Polimi enrollment/transcript documents plus "B2" self-declaration.
- **March 2026:** IELTS accessibility arrangements pursued with British Council, likely as a formal certification path or backup.
- **24 June 2026:** Alessio reported an IELTS Academic score of **7.5**, making the formal certification available after the application phase.

Answer: the alternative pathway supported the application submission; IELTS was later completed and superseded the provisional B2 pathway for final documentation.
`);
  md = replaceSection(md, 'Review Resolution', `
Registration-fee tension resolved: the €250 fee was already paid before the 23 April invoice, with safest payment date "on or before 2 April 2026." Tuition-deadline dates are separate from the registration fee and later made mostly moot by full tuition exemption. The 28DIGITAL/EIT naming should be treated as the same operational payment/foundation context in this wiki, while preserving exact source names.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-1095.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Review Resolution', `
The 23 April 2026 invoice documents an already-paid €250 registration fee. It should be read as an after-the-fact invoice/receipt, not as the payment date. Other EIT sources place the paid status no later than 2 April 2026.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-1185.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    '- **Tuition fee deadlines**: 29 May 2026, 30 June 2026, or 17 July 2026 (exact deadline for Alessio not specified)',
    '- **Tuition fee deadlines**: 29 May 2026, 30 June 2026, or 17 July 2026 (generic tuition schedule; later sources document full tuition exemption for Alessio)',
  );
  md = md.replace(
    '- Tuition fee must be paid by one of the three listed deadlines. This is a high‑priority action item for Alessio.',
    '- The listed tuition deadlines are preserved as administrative context, but later sources document full tuition exemption for Alessio.',
  );
  md = replaceSection(md, 'Review Resolution', `
This welcome email is consistent with a registration fee already paid before 5 April 2026. The later invoice from 23 April 2026 should be interpreted as an invoice/receipt for the already-paid fee. The May-July dates are tuition-payment schedule options, not registration-fee deadlines.
`);
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-1187.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    '### Acceptance Confirmation (mail-thread-1187)',
    '### Acceptance Confirmation (mail-thread-1187)',
  );
  md = replaceSection(md, 'Registration Fee Resolution', `
The registration fee was already resolved by the time the acceptance/welcome flow completed. The statement that the registration-fee deadline had passed should not be compared to the later May-July tuition deadlines. [[mail-thread-1095]] is dated 23 April 2026 but states that the fee was already paid before that invoice date; the safest exact statement is that the €250 fee was paid **on or before 2 April 2026**.
`);
  md = md.replace(
    /1\. \*\*Registration fee resolution:\*\*[\s\S]*?2\. \*\*Acceptance action evidence:\*\*/,
    '1. **Acceptance action evidence:**',
  );
  md = md.replace('3. **Tuition payment timing:** Which of the three tuition deadlines did Alessio eventually follow?', '2. **Tuition payment timing:** Later sources document full tuition exemption; no separate tuition payment is currently documented.');
  write(rel, md);
}

for (const rel of ['wiki/organizations/28digital-master-school.md', 'wiki/organizations/eit-digital-education-foundation.md']) {
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'Entity Naming Resolution', `
The wiki should treat **28DIGITAL Education Foundation** and **EIT Digital Education Foundation** as the same operational payment/foundation context for Alessio's EIT Digital Master School records. Source wording should still be preserved exactly:

- bank account holder / ` + '`28digital.eu`' + ` administrative context: **28DIGITAL Education Foundation**;
- invoice/foundation page label: **EIT Digital Education Foundation**.

No evidence currently requires two unrelated entities. A legal-name verification could refine the wording later, but for wiki navigation these pages should be tightly cross-linked rather than treated as separate organizations.
`);
  write(rel, md);
}

{
  const rel = 'wiki/topics/ielts-accessibility-request-2026.md';
  let md = bumpUpdated(read(rel));
  md = md.replace(
    /## Outcome note[\s\S]*$/,
    `## Outcome Note

The March 2026 accessibility request should be separated from the EIT application submission pathway.

- For the EIT Digital application submitted before 11 February 2026, Alessio used the alternative pathway recommended by [[federico-schiepatti]]: Polimi enrollment certificate/transcript plus a "B2" self-declaration in the "other" field.
- In March 2026, he pursued IELTS Academic special arrangements with British Council.
- By 24 June 2026, Alessio reported achieving IELTS Academic **7.5** in [[mail-thread-177]].

Resolution: the IELTS request was not needed for the initial EIT application submission, but the later IELTS result provided a formal English certificate after the provisional/alternative pathway. The accessibility-request administrative outcome is not separately documented, but the certification-status tension is resolved.
`,
  );
  write(rel, md);
}

{
  const rel = 'wiki/sources/mail-thread-1747.md';
  let md = bumpUpdated(read(rel));
  md = replaceSection(md, 'English Certification Resolution', `
This February guidance explains the application-stage workaround: use Polimi documents and a B2 self-declaration. It does not conflict with the later IELTS process. [[mail-thread-177]] records that Alessio achieved IELTS Academic 7.5 on 24 June 2026, after the application phase.
`);
  write(rel, md);
}

markResolved(
  ['review-48', 'review-150', 'review-151', 'review-156', 'review-158', 'review-232'],
  {
    'review-48': 'KTH/EIT is the confirmed current plan; XJTU was a separate exploratory option and is no longer current.',
    'review-150': 'Registration fee invoice dated 23 Apr 2026 is an after-the-fact invoice/receipt for a fee already paid on or before 2 Apr 2026.',
    'review-151': '28DIGITAL and EIT Digital Education Foundation are treated as the same operational payment/foundation context, preserving exact source labels.',
    'review-156': 'Registration-fee deadline is distinct from later tuition deadlines; the registration fee was already paid before the invoice date.',
    'review-158': 'Same registration-fee discrepancy resolved via paid-before-invoice interpretation and separate tuition-deadline context.',
    'review-232': 'Alternative B2 pathway was used for application submission; IELTS 7.5 was later achieved on 24 Jun 2026.',
  },
);
