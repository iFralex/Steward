#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/alessioantonucci/Second Me";
const TODAY = "2026-07-04";

function file(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(file(rel), "utf8");
}

function write(rel, text) {
  fs.writeFileSync(file(rel), text);
}

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) {
    throw new Error(`Missing expected text for ${label}`);
  }
  return text.replace(from, to);
}

function setUpdated(text) {
  return text.replace(/^updated: .+$/m, `updated: ${TODAY}`);
}

function resolveReview(ids, note) {
  const reviewPath = file(".llm-wiki/review.json");
  const data = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  const now = new Date().toISOString();
  const found = new Set();
  for (const item of data) {
    if (ids.includes(item.id)) {
      item.resolved = true;
      item.resolvedAt = now;
      item.resolution = note[item.id] ?? "Resolved in finance/property review batch.";
      found.add(item.id);
    }
  }
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new Error(`Review ids not found: ${missing.join(", ")}`);
  }
  fs.writeFileSync(reviewPath, JSON.stringify(data, null, 2) + "\n");
}

// Alessio: add a compact residence/property section to the person page body.
{
  const rel = "wiki/people/alessio-antonucci.md";
  let text = setUpdated(read(rel));
  if (!text.includes("## Residence and Property")) {
    text = replaceOnce(
      text,
      "## Professional Career\n",
      `## Residence and Property

Alessio's legal/family residence is [[property-via-orchidee-2|Via delle Orchidee 2, Cisterna di Latina]]. He co-owns the family home with his sister [[giulia-antonucci]], each holding a 1/2 share, acquired by deed of sale on 20 January 2020 before notary Francesco Vangi and registered on 28 January 2020. Alessio was 15 at acquisition; the cadastral and registry records identify Alessio and Giulia as owners, while [[sonia-marfoli]] is the household reference person for ANPR registry purposes.

This property context is separate from his university accommodation in Milan and from the later rental/investment property at [[property-cisterna-di-latina|via Pietro Gasbarra 5]].

## Professional Career
`,
      "Alessio residence/property section",
    );
  }
  if (!text.includes("## Family Administrative Support")) {
    text = replaceOnce(
      text,
      "## Commitments\n",
      `## Family Administrative Support

Alessio frequently handles family administrative and financial paperwork, especially for [[sonia-marfoli]]. Documented examples include forwarding CUD/Certificazione Unica material to banks, requesting Deutsche Bank statements and average-balance documents for ISEE purposes, and supporting household telecom/discount applications. These records should be treated as family administration and caregiving context, not as a separate paid tax-assistance activity unless a source explicitly shows compensation.

## Commitments
`,
      "Alessio family administrative support section",
    );
  }
  write(rel, text);
}

// Giulia: remove editorial confirmation wording and make the Gasbarra relationship direct.
{
  const rel = "wiki/people/giulia-antonucci.md";
  let text = setUpdated(read(rel));
  text = text.replace(
    "The source (mail‑thread‑110.md) does not specify her exact relationship to Alessio, but it is independently confirmed that she is his sister.",
    "The source (mail‑thread‑110.md) lists Giulia as beneficiary; in the wiki context she is Alessio's sister and co-beneficiary for that deposit transfer.",
  );
  text = text.replace(
    "The source CV was originally flagged as a non‑Alessio CV because it is not evidence about Alessio's own career. Alessio confirmed in June 2026 that Giulia is his sister and that the document should remain in the wiki as family context. The property information from mail‑thread‑110.md is retained for completeness.",
    "The source CV was originally flagged as a non‑Alessio CV because it is not evidence about Alessio's own career. It remains in the wiki as family context for Alessio's sister. The property information from mail‑thread‑110.md is retained for completeness.",
  );
  write(rel, text);
}

// Sonia: remove editorial confirmation wording, keep documentary basis.
{
  const rel = "wiki/people/sonia-marfoli.md";
  let text = setUpdated(read(rel));
  text = text.replace(
    '**Confirmed** — Alessio confirmed in June 2026 that Sonia Marfoli is his mother. The INPS certificate (2023), BNL form (2025), Stato di Famiglia (2026), the 2026 personal data update questionnaire, and the 2021 cardiology consultation email all provide official documentation of the mother‑son relationship and her role as head of household.',
    '**Confirmed** — The INPS certificate (2023), BNL form (2025), Stato di Famiglia (2026), the 2026 personal data update questionnaire, and the 2021 cardiology consultation email all provide official documentation of the mother-son relationship and her role as head of household.',
  );
  write(rel, text);
}

// Via Orchidee: fix frontmatter and clarify parent role.
{
  const rel = "wiki/topics/property-via-orchidee-2.md";
  let text = setUpdated(read(rel));
  text = text.replace(
    'related: ["alessio-antonucci", "giulia-antonucci", "sonia-marfoli", "gianni-marfoli", "rita-d-annibale", "property-co-ownership"]sources:',
    'related: ["alessio-antonucci", "giulia-antonucci", "sonia-marfoli", "gianni-marfoli", "rita-d-annibale", "property-co-ownership"]\nsources:',
  );
  if (!text.includes("## Parent Role Resolution")) {
    text = replaceOnce(
      text,
      "## Notes on the \"Interno: 1\" Designation\n",
      `## Parent Role Resolution

The available cadastral and registry records identify [[alessio-antonucci]] and [[giulia-antonucci]] as registered owners, each with a 1/2 share. [[sonia-marfoli]] is documented as resident and as the ANPR household reference person, but not as registered owner. Because both owners were minors at acquisition, parental or family involvement in funding/signing is plausible; however, no current source documents a retained parental ownership share, usufruct, or beneficial interest. The wiki should therefore record the registered ownership and leave the funding/legal mechanics as unknown.

## Notes on the "Interno: 1" Designation
`,
      "Via Orchidee parent role section",
    );
  }
  write(rel, text);
}

// Gasbarra: make Giulia's relationship unambiguous.
{
  const rel = "wiki/topics/property-cisterna-di-latina.md";
  let text = setUpdated(read(rel));
  text = text.replace(
    "[[giulia-antonucci]] — co-beneficiary of the security deposit",
    "[[giulia-antonucci]] — Alessio's sister and co-beneficiary of the security deposit",
  );
  write(rel, text);
}

// Financial profile: distinguish unrecoverable historical unknowns from active open questions.
{
  const rel = "wiki/topics/financial-profile.md";
  let text = setUpdated(read(rel));
  text = text.replace(
    "- **Emolumenti**: +€978.50 (likely salary from freelance/part-time or scholarship)\n- **Bonifico a Vostro Favore**: +€600.00 (likely family transfer or client recurring payment)",
    "- **Emolumenti**: +€978.50 (historical BNL credit; exact origin not recoverable from current records)\n- **Bonifico a Vostro Favore**: +€600.00 (historical BNL credit; exact origin not recoverable from current records)",
  );
  text = text.replace(
    "- The €3,000 difference is a blocked pending commitment. Its nature (deposit, reservation, hold) is unknown.",
    "- The €3,000 difference is a blocked pending commitment. Its nature is not recoverable from current records and should not be inferred as a specific deposit, reservation, tax payment, or investment hold without a matching source.",
  );
  text = text.replace(
    "1. What is the exact source of the historical BNL \"emolumenti\" credit? Unknown.\n2. What was the historical €600/month \"bonifico a vostro favore\"? Unknown.\n3. What did the €3,000 pending BNL commitment represent? Unknown.\n4. Did Deutsche Bank fulfil the March 2025 document request for Sonia Marfoli's account statements?",
    "1. Did Deutsche Bank fulfil any later document requests beyond the March 2025 follow-up already documented?\n2. Does Sonia Marfoli hold any other bank accounts beyond Deutsche Bank that would also be relevant for ISEE?\n3. How does Alessio's financial profile change after graduation and possible double-degree Master's (2026–2028)?\n\n### Closed Historical Unknowns\n\nThe exact source of the BNL \"emolumenti\" credit, the €600/month \"bonifico a vostro favore\", and the €3,000 pending BNL commitment cannot be reconstructed from the current records. Keep them as historical statement facts, not active claims about Alessio's current income source or obligations.\n\n4. Did Deutsche Bank fulfil the March 2025 document request for Sonia Marfoli's account statements?",
  );
  text = text.replace(
    "4. Did Deutsche Bank fulfil the March 2025 document request for Sonia Marfoli's account statements?\n5. Does Sonia Marfoli hold any other bank accounts beyond Deutsche Bank that would also be relevant for ISEE?\n6. How does Alessio's financial profile change after graduation and possible double-degree Master's (2026–2028)?",
    "",
  );
  write(rel, text);
}

// GIANNI/Mooney: connect likely identity while preserving card-holder caution.
{
  const rel = "wiki/people/gianni.md";
  let text = setUpdated(read(rel));
  text = text.replace("tags: [unknown-relation, tentative]", "tags: [family, maternal-uncle, mooney, tentative]");
  text = text.replace("related: [alessio-antonucci, mooney-spa]", "related: [alessio-antonucci, gianni-marfoli, mooney-spa]");
  text = replaceOnce(
    text,
    `GIANNI is a person named in an IBAN certification issued by Mooney S.p.A. on 2024-09-29. The certification was delivered to Alessio Antonucci's email address but is addressed to GIANNI. The identity and relationship of GIANNI to Alessio are currently unknown.

**Possible interpretations:**
- GIANNI could be a family member (father, brother) for whom Alessio is managing the card.
- GIANNI could be an alias or app-generated placeholder name.
- The card could be a joint or secondary card.

This entry is a tentative placeholder; further sources may clarify the connection.`,
    `GIANNI is the name printed on an IBAN certification issued by Mooney S.p.A. on 2024-09-29. The certification was delivered to Alessio Antonucci's email address but is addressed to GIANNI.

The strongest wiki match is [[gianni-marfoli]], Alessio's maternal uncle, because he is a documented close family member named Gianni. This resolves the relationship question at the person-entity level, but it does not by itself prove that the Mooney card was owned or used by Alessio.

Working interpretation: treat the certification as a family/administrative financial document involving Gianni Marfoli, received or managed through Alessio's email. Do not attribute the card holder status to Alessio unless a separate Mooney source names Alessio directly.`,
    "GIANNI page body",
  );
  write(rel, text);
}

{
  const rel = "wiki/queries/who-is-gianni.md";
  let text = setUpdated(read(rel));
  text = text.replace("tags: [unresolved, relationship]", "tags: [resolved, relationship, family, mooney]");
  text = text.replace("related: [gianni, alessio-antonucci, mooney-spa]", "related: [gianni, gianni-marfoli, alessio-antonucci, mooney-spa]");
  text = replaceOnce(
    text,
    `An IBAN certification from Mooney S.p.A. for a prepaid card (dated 2024-09-29) was delivered to Alessio's email but addressed to **GIANNI**. The identity and relationship of GIANNI to Alessio are unknown.

**Possible interpretations:**
- Family member (e.g., father, brother) for whom Alessio manages the card.
- Alias or app placeholder.
- Joint or secondary cardholder.

**Evidence needed from future sources:**
- Any additional emails or documents that mention GIANNI or clarify the card usage.
- Conversations or notes mentioning a family member named Gianni.
- A direct statement from Alessio about the card's ownership.`,
    `An IBAN certification from Mooney S.p.A. for a prepaid card (dated 2024-09-29) was delivered to Alessio's email but addressed to **GIANNI**.

The likely identity is [[gianni-marfoli]], Alessio's maternal uncle. This is supported by the separate family page documenting Gianni Marfoli as Sonia Marfoli's brother and Alessio's uncle.

Resolution: the relationship is family, likely maternal uncle. The card/account ownership question remains narrower: the Mooney certification should be associated with Gianni unless a direct Mooney source names Alessio as holder or authorized user.`,
    "Who is Gianni query body",
  );
  write(rel, text);
}

{
  const rel = "wiki/organizations/mooney-spa.md";
  let text = setUpdated(read(rel));
  text = text.replace('related: ["alessio-antonucci", "gianni", "mail-thread-10912", "mail-thread-15000", "sisalpay", "mail-thread-24947"]', 'related: ["alessio-antonucci", "gianni", "gianni-marfoli", "mail-thread-10912", "mail-thread-15000", "sisalpay", "mail-thread-24947"]');
  text = text.replace(
    "In the context of this wiki, Mooney issued an IBAN certification on 2024-09-29 for a card that appears to be used by Alessio Antonucci, though the certificate was addressed to **GIANNI** (see [[who-is-gianni]]).",
    "In the context of this wiki, Mooney issued an IBAN certification on 2024-09-29 addressed to **GIANNI**. The likely person match is [[gianni-marfoli]], Alessio's maternal uncle; the document was received in Alessio's email context, but it should not be treated as proof that Alessio was the card holder.",
  );
  text = text.replace(
    "- **SisalPay prepaid card** – held by Alessio Antonucci. In July 2024, Mooney communicated a unilateral modification to the SisalPay card terms, reducing usage limits for fraud prevention.",
    "- **SisalPay prepaid card** – documented through family/administrative correspondence. In July 2024, Mooney communicated a unilateral modification to the SisalPay card terms, reducing usage limits for fraud prevention. Holder identity should be checked against each source before attribution.",
  );
  write(rel, text);
}

resolveReview(
  ["review-84", "review-85", "review-86", "review-105", "review-106", "review-116", "review-125", "review-447", "review-448"],
  {
    "review-84": "Alessio page now includes residence/property ownership facts for Via delle Orchidee 2.",
    "review-85": "Giulia page already includes fiscal code, birth details, and property facts; wording cleaned up.",
    "review-86": "Parent role documented conservatively: registered ownership is Alessio/Giulia; parent funding/legal mechanics remain unknown.",
    "review-105": "Historical BNL income credits recorded as unrecoverable from current records; no speculative current-income claim.",
    "review-106": "Historical BNL €3,000 pending commitment recorded as unrecoverable from current records; no speculative obligation claim.",
    "review-116": "GIANNI linked to likely family identity Gianni Marfoli while preserving caution on Mooney card ownership.",
    "review-125": "Giulia relationship clarified as Alessio's sister and co-beneficiary for the Gasbarra deposit.",
    "review-447": "Sonia relationship resolved as Alessio's mother in Sonia page and related family documentation.",
    "review-448": "Alessio page now documents recurring family administrative/tax-document support as caregiving/household context, not paid tax work.",
  },
);

console.log("Resolved finance/property/family batch.");
