import fs from "node:fs";
import path from "node:path";

const root = "/Users/alessioantonucci/Second Me";
const reviewPath = path.join(root, ".llm-wiki", "review.json");
const today = "2026-07-03";

function file(rel) {
  return path.join(root, rel);
}

function read(rel) {
  return fs.readFileSync(file(rel), "utf8");
}

function write(rel, content) {
  fs.writeFileSync(file(rel), content);
}

function replaceAllInFile(rel, replacements) {
  let current = read(rel);
  let next = current;
  for (const [from, to] of replacements) {
    next = next.replace(from, to);
  }
  if (next !== current) {
    write(rel, next);
    return true;
  }
  return false;
}

function ensureSection(rel, marker, block) {
  const current = read(rel);
  if (current.includes(marker)) return false;
  write(rel, `${current.replace(/\s*$/, "")}\n\n${block.trim()}\n`);
  return true;
}

function upsert(rel, content) {
  const target = file(rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    return ensureSection(rel, "## Current Use", content);
  }
  fs.writeFileSync(target, `${content.trim()}\n`);
  return true;
}

let changed = 0;

// Remove previous metatextual provenance notes the user does not want in the wiki prose.
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const current = fs.readFileSync(p, "utf8");
      const next = current
        .replace(/\s*\(confirmed by Alessio, June 2026\)/g, "")
        .replace(/\s*\(confirmed by Alessio, July 2026\)/g, "")
        .replace(/\s*\(confirmed by Alessio, 2026-07-03\)/g, "");
      if (next !== current) {
        fs.writeFileSync(p, next);
        changed++;
      }
    }
  }
}
walk(file("wiki"));

// Application outcomes.
const rejectedStatusFiles = [
  "wiki/experiences/google-step-internship-application.md",
  "wiki/experiences/google-application-multichance-2026.md",
  "wiki/experiences/index-2025-application.md",
  "wiki/experiences/jp-morgan-internship-application.md",
  "wiki/experiences/leadthefuture-application.md",
  "wiki/experiences/contentful-software-engineer-application.md",
  "wiki/experiences/oracle-software-development-internship-application.md",
  "wiki/experiences/bending-spoons-employability-scholarship-application-2025.md",
];
for (const rel of rejectedStatusFiles) {
  if (!fs.existsSync(file(rel))) continue;
  changed += replaceAllInFile(rel, [
    [/status: (uncertain|historical|no_response|completed|not_accepted)/, "status: rejected"],
    [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
    [/No response received \/ no offer received/g, "Rejected / no offer received"],
    [/was rejected or did not lead to an offer/g, "was rejected and did not lead to an offer"],
    [/Rejected \/ no offer received\./g, "Rejected / no offer received."],
  ]);
}

changed += replaceAllInFile("wiki/topics/bending-spoons-employability-scholarship.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/was rejected or did not lead to an offer/g, "was rejected and did not lead to an offer"],
]);

// Bachelor degree progress and completion.
changed += replaceAllInFile("wiki/experiences/bachelor-polimi.md", [
  [/status: current/, "status: completed"],
  [/end_date: 2026-07-31/, `end_date: ${today}`],
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/Alessio Antonucci is pursuing a Bachelor’s degree/, "Alessio Antonucci completed a Bachelor’s degree"],
  [/- \*\*Expected completion:\*\* Summer 2026 \(July per most CVs; a March 2026 date appears in some documents – see Graduation Date Ambiguity below\)/, `- **Completion:** completed by July 2026. The exact administrative graduation/session date is not separately recorded in the wiki.`],
  [/- \*\*Current degree:\*\* Student at Politecnico di Milano\n- \*\*Years of study:\*\* 2\/3 \(as of late 2024 per CV per ita; consistent across multiple CVs\)/, "- **Degree status:** completed\n- **Earlier CV phrase:** `2/3 year bachelor's degree` meant second year of a three-year programme at that point, not two-thirds completed as a precise credit count."],
  [/Multiple CV versions document Alessio’s progress\. The phrase "2\/3 year" across many reports likely indicates the programme’s three‑year structure \(i\.e\., second year or two‑thirds complete\) rather than a literal fraction\./, "Multiple CV versions document Alessio’s progress. The phrase \"2/3 year\" in the older CVs meant second year of a three-year programme at that point. The degree has since been completed."],
  [/\n2\. \*\*"2\/3 year" phrasing in early CVs:\*\* The mid‑2023 CV stating "2\/3 year" is inconsistent with a September 2023 start \(would suggest first year, not second\)\. This may reflect ambiguous phrasing or a CV template error\./, ""],
]);

changed += ensureSection(
  "wiki/queries/education-progress-clarification.md",
  "## Resolution",
  `
## Resolution

The phrase "2/3 year bachelor's degree" meant second year of a three-year Bachelor's programme at the time of the CV. It should not be read as a precise credits-completed fraction. The Bachelor's degree has since been completed.
`
);

// ST Engineering team-management claim de-emphasis.
changed += replaceAllInFile("wiki/experiences/ai-engineer-st-engineering-antycip.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/; team management/g, ""],
  [/; team of 5 across 3 countries/g, ""],
  [/team management, /g, ""],
  [/- \*\*Additional\*\*: Smart working policy documented; team of 5 across 3 countries\n/, "- **Additional**: Smart working policy documented.\n"],
]);
changed += ensureSection(
  "wiki/experiences/ai-engineer-st-engineering-antycip.md",
  "## Leadership Claim Handling",
  `
## Leadership Claim Handling

The older CV wording about managing a team of five across three countries is no longer used as a core strength on this page. The work is better represented through concrete technical contributions: VR-Forces simulation, Monte Carlo/ML experimentation, Unreal Engine integration, MyIG, website work, and operational collaboration.
`
);

changed += replaceAllInFile("wiki/experiences/software-engineer-ai-division-st-engineering-antycip.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/\"team-management\", /g, ""],
  [/\"team-lead\"/g, "\"ai-integration\""],
  [/## Self-Described Responsibilities \(CV8 & Letter\)\n\n- \*\*AI Division Lead\*\*: Led a new AI business division integrating artificial intelligence into \[\[vr-forces\]\] military simulation software \(MAK\)\.\n- \*\*Team management\*\*: Managed an international team of 5 across 3 countries\. The letter adds: “I led the small team for this project, as I was the person with the most knowledge about AI\.”\n/, "## Self-Described Responsibilities (CV8 & Letter)\n\n- **AI integration**: Worked on integrating artificial intelligence into [[vr-forces]] military simulation software (MAK).\n"],
  [/\n- \*\*VR Forces \+ Monte Carlo \+ ML\*\*: Led a small team using VR Forces \(MAK suite\) to simulate war contexts with Monte Carlo simulation and machine learning – the first real ML project at the company\./, "\n- **VR Forces + Monte Carlo + ML**: Worked on VR Forces (MAK suite) experiments for war-context simulation with Monte Carlo simulation and machine learning."],
  [/\n\*\*Skills Demonstrated:\*\*\n- Strong attention to detail in design and development\n- Team working\n- Consulting\n- Leadership in AI integration\n- End-to-end project management\n- VR development \(self-taught via colleagues\)/, "\n**Skills Demonstrated:**\n- Strong attention to detail in design and development\n- Team working\n- Consulting\n- AI integration\n- VR development (self-taught via colleagues)"],
  [/This is the only CV in the wiki that provides a concrete team size \(5 people across 3 countries\) for the ST Engineering Antycip role\. It also omits/, "This page no longer treats the team-size phrasing as a point of strength. CV8 also omits"],
]);

changed += replaceAllInFile("wiki/experiences/software-engineer-st-engineering-antycip.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/ The role is remote, with an international team of 5 people spanning 3 countries\./, " The role is remote."],
  [/\n- Coordinating with an international team across three countries\./, ""],
  [/Despite the varying titles, the division leadership and AI integration responsibilities remain consistent across all versions\./, "Despite the varying titles, the AI-integration and simulation-development responsibilities remain consistent across the strongest sources."],
]);

changed += replaceAllInFile("wiki/organizations/st-engineering-antycip.md", [
  [/- \*\*CV7 \(late 2025 \/ early 2026\)\*\*: AI Engineer, leading AI division, team of 5 across 3 countries/, "- **CV7 (late 2025 / early 2026)**: AI Engineer, AI-integration framing"],
]);

// Health procedure.
changed += replaceAllInFile("wiki/topics/health-insurance-coverage.md", [
  [/A medical-procedure document references both an insured-patient deductible and a self-paying deposit\. The current evidence does not establish whether Alessio had private insurance for that procedure or whether the insured-patient language is part of a generic clinic template\./, "The planned February 2026 procedure was self-paid rather than covered by private insurance. It was not performed privately because the cost was too high; Alessio is waiting through the public healthcare list instead."],
  [/## Review Resolution[\s\S]*$/, "## Resolution\n\nThe insured-patient wording in the estimate should be treated as template/administrative language for this case. The practical outcome was self-pay, no private procedure, and a pending public-list pathway.\n"],
]);

changed += replaceAllInFile("wiki/topics/alessio-medical-condition.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/### Adult Circumcision \(February 2026\)[\s\S]*?## Notes and Open Questions/, `### Adult Circumcision (February 2026)\n- **Procedure:** Circoncisione, età > 17 anni\n- **Hospital:** [[fondazione-policlinico-universitario-campus-bio-medico]] (Rome) – UNISALUTE private wing\n- **Surgeon:** [[angelo-civitella]] (Urology)\n- **Planned private date:** 14 February 2026 (day hospital)\n- **Cost estimate:** €1,600.00 (80% deposit requested); source: [[preventivo-spesa-circoncisione-febbraio-2026]]\n- **Outcome:** the private procedure did not take place because the cost was too high. It should be treated as a planned-but-not-completed private procedure; Alessio is waiting through the public healthcare list.\n- **Payment regime:** self-paid. The insured-patient wording in the estimate is not evidence of private insurance coverage for this procedure.\n\n## Notes and Open Questions`],
]);

changed += ensureSection(
  "wiki/sources/9-documenti--43-4d33458578eeb394-antonucci-alessio-14022026--14rgn7.md",
  "## Outcome Resolution",
  `
## Outcome Resolution

This source is a private cost estimate, not proof that the procedure occurred. The private procedure was not carried out because the cost was too high; the relevant current path is waiting through the public healthcare list.
`
);

// Disability card and DiscoverEU.
changed += replaceAllInFile("wiki/events/discovereu-2026.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/- \*\*Dates \(presumed\):\*\* 27 July – 10 August 2026 \(the agreement header has a likely typographical error; these dates are inferred from the 15-day duration and the agreement validity period of 1\/5\/2026 to 1\/10\/2026\)/, "- **Dates/times:** not yet precisely established. Earlier agreement material points toward a July-August 2026 window, but the exact stops, dates, train times, and itinerary remain to be finalized."],
  [/- \*\*Mandatory:\*\* \[\[european-disability-card\]\] – must be obtained via INPS before travel \(Art\. 7\.3 of the agreement\)/, "- **Mandatory:** [[european-disability-card]] – obtained in early July 2026"],
  [/- \*\*27 July – 10 August 2026\*\* – "Accessible Europe 2026" trip \(presumed\)/, "- **Summer 2026** – \"Accessible Europe 2026\" trip window; precise dates, stops, and train times still pending"],
  [/- Whether Alessio obtained the European Disability Card or personal travel insurance is unconfirmed\n/, "- The European Disability Card has been obtained; personal travel insurance is still not documented\n"],
  [/- Exact Eastern European destinations and itinerary are not specified in available documents/, "- Exact Eastern European destinations, timetable, and route order are not yet established"],
  [/- The exact dates depend on resolving the header typo in the agreement\n/, ""],
]);

changed += replaceAllInFile("wiki/topics/european-disability-card.md", [
  [/updated: 2026-07-03/, `updated: ${today}`],
  [/The card was a \*\*mandatory requirement\*\*[\s\S]*?Alessio's \[\[inps-handicap-certificate-2023\|official severe handicap determination \(L\.104\/92\) from October 2023\]\] serves as the prerequisite for obtaining the European Disability Card\./, "The card was a **mandatory requirement** for participation in the [[discovereu-inclusion|DiscoverEU Inclusion]] \"Accessible Europe 2026\" group trip organized by [[esplora|Associazione Esplora]] (Art. 7.3 of the participant agreement). Alessio obtained the card in early July 2026. His [[inps-handicap-certificate-2023|official severe handicap determination (L.104/92) from October 2023]] served as the prerequisite for obtaining it."],
]);

// Telecom discount.
changed += replaceAllInFile("wiki/topics/agevolazione-agcom-290-21-cons.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/Alessio’s official INPS certification[\s\S]*?If Alessio were to obtain a discounted plan, the \[\[european-disability-card\]\] obtained via INPS would serve as additional supporting documentation\./, "Alessio’s official INPS certification (L.104/92) documents congenital glaucoma with visus 1/20 and \"cecità bilaterale,\" which meets the \"non vedente\" criteria under Legge 138/2001. Alessio uses Vodafone and has the disability discount active there. The Fastweb template should be treated as comparison/shopping documentation rather than the active benefit path. The one-benefit-per-user limit means Vodafone is the relevant active operator for this benefit in the wiki."],
]);

changed += replaceAllInFile("wiki/organizations/vodafone-italia.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/No evidence exists that Alessio completed, submitted, or was granted any Vodafone discounted service\. The blank template indicates awareness of the benefit scheme but does not confirm an active subscription\./, "Alessio uses Vodafone and has the disability discount active under [[agevolazione-agcom-290-21-cons]]. The blank template remains the archived form evidence, while the current relationship is an active discounted Vodafone service."],
]);

changed += ensureSection(
  "wiki/organizations/fastweb.md",
  "## Discount Outcome",
  `
## Discount Outcome

For Alessio's own telecom discount path, Vodafone is the active operator. The Fastweb form is retained as comparison/template evidence rather than an active discounted service for Alessio.
`
);

// Banking profile.
changed += replaceAllInFile("wiki/topics/financial-profile.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/\| BNL \(Banca Nazionale del Lavoro\) \| Current account \(conto corrente\) \| Active at least since Jan 2024; KYC documented Oct 2025 \(Practice ID KYC00000000000039TGD\) \| Likely primary Italian bank \|/, "| BNL (Banca Nazionale del Lavoro) | Current account (conto corrente) | Closed; historically active in 2024-2025 documents | Former Italian bank account |"],
  [/\| Revolut Bank UAB \| Digital banking \(two IBANs: LT303250046930277338 and LT343250029861224902\) \| May 2026 \(DiscoverEU payments\) – IBAN discrepancy flagged \| Secondary\/digital; likely destination of international transfers from BNL \|/, "| Revolut Bank UAB | Digital banking, personal and Pro accounts | Active | Primary banking platform; the earlier Lithuanian IBAN caused acceptance issues with some payers |"],
  [/\| Apple Pay \| Payment method \| June 2026 \(Italo train ticket\) \| No underlying account documented \|/, "| Buddybank | Italian bank account | Active | Used to receive payments when Revolut's Lithuanian IBAN was not accepted |\n| FinecoBank | Bank and investment/brokerage account | Active | Used for ETF investments, currently about €100k invested in ETFs |\n| Hype | Digital/prepaid account | Active but rarely used | Emergency fallback account |\n| Apple Pay | Payment method | June 2026 (Italo train ticket) | No underlying account documented |"],
  [/Based on BNL account statement/, "Historical BNL account statement"],
  [/## Open Questions[\s\S]*$/, `## Current Banking Setup\n\nBNL is closed. Revolut is the main account platform, including both personal and Pro usage. Buddybank is used for receiving payments when Revolut's Lithuanian IBAN is not accepted. FinecoBank is the investment account, currently used for about €100k in ETFs. Hype exists as an emergency fallback and is rarely used.\n\n## Open Questions\n\n1. What is the exact source of the historical BNL \"emolumenti\" credit? Could be freelance income, scholarship, or a part-time role.\n2. What was the historical €600/month \"bonifico a vostro favore\"? Likely a recurring family contribution or retainer fee.\n3. What did the €3,000 pending BNL commitment represent? Possibly a security deposit, tuition payment, or a hold for a large purchase.\n4. Did Deutsche Bank fulfil the March 2025 document request for Sonia Marfoli's account statements?\n5. Does Sonia Marfoli hold any other bank accounts beyond Deutsche Bank that would also be relevant for ISEE?\n6. How does Alessio's financial profile change after graduation and possible double-degree Master's (2026–2028)?\n`],
]);

changed += replaceAllInFile("wiki/entities/revolut-account.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/Alessio Antonucci holds an account with \*\*Revolut Bank UAB\*\*, a Lithuanian-regulated bank\. The account is used for international transactions, including DiscoverEU-related payments and likely as a receiving account for transfers from his BNL domestic account\./, "Alessio Antonucci uses **Revolut** as his main banking platform, including both the normal/personal account and Revolut Pro. Earlier documents show Lithuanian Revolut IBANs; that created practical acceptance issues with some payers, so Buddybank is also used to receive payments."],
  [/## Connection to BNL International Transfers[\s\S]*?## Address on File/, "## Relationship to Other Accounts\n\nBNL is now closed. Revolut is the primary platform for ordinary banking and Pro usage. Buddybank is used to receive payments when a domestic Italian IBAN is needed. FinecoBank holds Alessio's ETF investments, while Hype is retained as an emergency fallback.\n\n## Address on File"],
  [/## Usage[\s\S]*$/, "## Usage\n\nRevolut is the main account platform for everyday and Pro banking. It is also documented in the DiscoverEU 2026 payments. The older interpretation of Revolut as merely a secondary travel account is superseded.\n"],
]);

changed += replaceAllInFile("wiki/organizations/bnl-banca-nazionale-del-lavoro.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/Alessio holds a personal current account/, "Alessio previously held a personal current account"],
  [/The account purpose is personal\/private use\./, "The account is now closed; its documented purpose was personal/private use."],
]);
changed += ensureSection(
  "wiki/organizations/bnl-banca-nazionale-del-lavoro.md",
  "## Current Status",
  `
## Current Status

The BNL account is closed. It remains historically relevant because 2024-2025 documents preserve KYC, privacy, account-statement, and insurance/payment context.
`
);

changed += replaceAllInFile("wiki/organizations/finecobank.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/On 22 June 2026, a notification sent to `ifralex\.business@gmail\.com` confirmed the account and the \[\[portafoglio-remunerato\]\] service\. On the same day, he deposited €97,000, and on 23 June 2026 he invested the amount in two ETFs\./, "On 22 June 2026, a notification sent to `ifralex.business@gmail.com` confirmed the account and the [[portafoglio-remunerato]] service. The account is currently used for ETF investments, with about €100k invested in ETFs."],
]);

changed += upsert(
  "wiki/organizations/buddybank.md",
  `---
type: organization
title: Buddybank
created: ${today}
updated: ${today}
tags: [banking, finance, italian-bank, payments]
related: [alessio-antonucci, financial-profile, revolut-account]
sources: []
---
# Buddybank

Buddybank is part of Alessio Antonucci's current banking setup. It is used mainly to receive payments when Revolut's Lithuanian IBAN is not accepted by counterparties.

## Current Use

Buddybank is not the primary banking platform; Revolut is primary. Buddybank's role is practical domestic-IBAN/payment reception.`
);

changed += upsert(
  "wiki/organizations/hype.md",
  `---
type: organization
title: Hype
created: ${today}
updated: ${today}
tags: [banking, finance, prepaid, emergency-account]
related: [alessio-antonucci, financial-profile]
sources: []
---
# Hype

Hype is part of Alessio Antonucci's current banking setup but is rarely used.

## Current Use

Hype is retained as an emergency fallback account, not as a primary spending or investment account.`
);

changed += replaceAllInFile("wiki/topics/personal-finance-accounts.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
  [/\| \[\[finecobank\]\] \| Full‑service Italian bank with securities custody \| Active \(opened mid‑Jun 2026\) \| Brokerage account with derivatives trading enabled \(CFDs, Futures, Options, etc\.\) as of 18 Jun 2026\. Knowledge questionnaire requirement pending\. On 22 Jun 2026 a €97,000 deposit was made; on 23 Jun 2026 two ETFs were purchased\. Attempted \[\[credit-lombard\]\] on 23 Jun 2026 \(rejected due to `dossier abilitati` precondition\)\. Account confirmed via Portafoglio Remunerato service notification \(22 Jun 2026\)\. \| \[\[mail-thread-37420\]\], \[\[mail-thread-37430\]\] \|/, "| [[finecobank]] | Full-service Italian bank with securities custody | Active (opened mid-Jun 2026) | Investment account currently holding about €100k in ETFs. Derivatives trading was enabled in June 2026; Credit Lombard attempt was blocked by a `dossier abilitati` precondition. | [[mail-thread-37420]], [[mail-thread-37430]] |"],
  [/\| \[\[google-payments\]\] \| Google Payments profile \| Active \| Profile ID 9128-7835-4008; tax data modified 12 Feb 2023; used for GCP invoice payments\. \| \[\[mail-thread-35180\]\] \|/, "| [[revolut-account]] | Digital banking, personal and Pro | Active | Main banking platform. Earlier Lithuanian IBAN acceptance issues explain the use of Buddybank for some payment receipts. | [[discovereu-2026]] |\n| [[buddybank]] | Italian bank account | Active | Used to receive payments when Revolut IBAN is not accepted. | user-maintained profile |\n| [[hype]] | Digital/prepaid account | Active, rarely used | Emergency fallback account. | user-maintained profile |\n| [[google-payments]] | Google Payments profile | Active | Profile ID 9128-7835-4008; tax data modified 12 Feb 2023; used for GCP invoice payments. | [[mail-thread-35180]] |"],
  [/What is the total value or composition of Alessio's securities holdings\? Only the two ETFs purchased in June 2026 are known\./, "What is the exact ETF composition at FinecoBank? The current high-level value is about €100k."],
  [/Are there additional bank accounts \(e\.g\., Unicredit, Intesa\) not yet captured\? Unknown\./, "Buddybank and Hype are now captured; additional accounts beyond these are not documented."],
]);

// CandidAI GitHub repository.
changed += replaceAllInFile("wiki/projects/candidai.md", [
  [/updated: 2026-06-[0-9]{2}/, `updated: ${today}`],
]);
changed += ensureSection(
  "wiki/projects/candidai.md",
  "## Repository",
  `
## Repository

The local project checkout at \`/Users/alessioantonucci/progetti/CandidAI\` points to the GitHub repository:

\`https://github.com/iFralex/CandidAI.git\`

The wiki should use this repository link for code provenance. The previously mentioned technical documentation file should not be used as a source for this review batch.
`
);

changed += ensureSection(
  "wiki/projects/candidai-tech.md",
  "## Repository",
  `
## Repository

The code repository for the CandidAI project is \`https://github.com/iFralex/CandidAI.git\`, as recorded in the local checkout's Git remote configuration.
`
);

// Review status updates.
const resolved = new Map([
  ["review-3", "CandidAI GitHub remote recorded; technical documentation file intentionally not used."],
  ["review-5", "Google STEP application outcome recorded as rejected/no offer."],
  ["review-8", "Google Multichance application outcome recorded as rejected/no offer."],
  ["review-27", "ST Engineering team-management claim de-emphasized and removed as a core strength."],
  ["review-34", "2/3 year phrasing resolved as second year of a three-year programme; Bachelor's now completed."],
  ["review-38", "INDEX 2025 outcome recorded as rejected/no offer."],
  ["review-41", "J.P. Morgan application outcome recorded as rejected/no offer; date/program details remain separate if needed."],
  ["review-43", "LeadTheFuture application outcome recorded as rejected/no offer."],
  ["review-51", "Contentful application outcome recorded as rejected/no offer; exact date remains unknown."],
  ["review-52", "Oracle application outcome recorded as rejected/no offer; exact date remains unknown."],
  ["review-58", "Bending Spoons EmployAbility Scholarship outcome recorded as rejected/no offer."],
  ["review-72", "DiscoverEU exact dates/times recorded as not yet precisely established."],
  ["review-75", "European Disability Card status updated as obtained in early July 2026."],
  ["review-76", "DiscoverEU itinerary recorded as not yet precisely established."],
  ["review-79", "Medical procedure payment regime recorded as self-pay."],
  ["review-80", "Planned private procedure recorded as not completed."],
  ["review-82", "Scheduled February 2026 private procedure recorded as not completed due to cost."],
  ["review-83", "Insured/self-pay ambiguity resolved as self-pay for this case."],
  ["review-89", "Fastweb discount path clarified as not active for Alessio; Vodafone is active."],
  ["review-92", "Fastweb template clarified as comparison/template evidence, not active discount."],
  ["review-97", "Active telecom disability discount recorded under Vodafone."],
  ["review-70", "Current banking setup recorded: BNL closed; Revolut primary; Buddybank, Fineco, Hype roles added."],
]);

const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
for (const item of review) {
  if (resolved.has(item.id)) {
    item.resolved = true;
    item.resolvedAt = new Date().toISOString();
    item.resolution = resolved.get(item.id);
  }
}
fs.writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);

console.log(`Changed ${changed} files/operations and resolved ${resolved.size} review items.`);
