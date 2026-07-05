#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/alessioantonucci/Second Me";
const TODAY = "2026-07-04";

function p(rel) {
  return path.join(ROOT, rel);
}

function edit(rel, fn) {
  const full = p(rel);
  const before = fs.readFileSync(full, "utf8");
  let after = before.replace(/^updated: .+$/m, `updated: ${TODAY}`);
  after = fn(after);
  if (after !== before) fs.writeFileSync(full, after);
}

edit("wiki/topics/double-degree-masters.md", (text) =>
  text
    .replace(
      "Earlier sources documented two parallel options, but Alessio confirmed in June 2026 that the KTH/EIT Digital route is confirmed and the XJTU option is no longer under consideration.",
      "Earlier sources documented two parallel options; the current plan is the KTH/EIT Digital route, while the XJTU option is no longer under consideration.",
    )
    .replace(
      "- **Status**: ~~High Performance Computing Engineering with XJTU~~ – **Previously evaluated, no longer under consideration** (Alessio confirmed he is not interested in pursuing this option, June 2026).",
      "- **Status**: ~~High Performance Computing Engineering with XJTU~~ – **Previously evaluated, no longer under consideration**.",
    )
    .replace(
      "The CV-Google.pdf is the first source to present the KTH double degree as a confirmed future plan with specific dates (09/2026 – 07/2028). Alessio confirmed in June 2026 that the KTH/EIT Digital path is confirmed. Earlier sources treated KTH and XJTU as applications/options in progress; the XJTU option is now historical only.",
      "The CV-Google.pdf is the first source to present the KTH double degree as a confirmed future plan with specific dates (09/2026 – 07/2028). Earlier sources treated KTH and XJTU as applications/options in progress; the KTH/EIT Digital path is now the current plan and the XJTU option is historical only.",
    ),
);

edit("wiki/experiences/double-degree-masters.md", (text) =>
  text
    .replace(
      "Earlier sources documented two parallel options, but Alessio confirmed in June 2026 that the KTH/EIT Digital route is the confirmed plan and the XJTU route is no longer under consideration.",
      "Earlier sources documented two parallel options; the KTH/EIT Digital route is the current plan and the XJTU route is no longer under consideration.",
    )
    .replace(
      "- **Status:** Confirmed (Alessio confirmed, June 2026; the most recent CV, 5f8a8cabc2dbcf2a-cv.pdf, also lists it as confirmed; personal questionnaire reiterates intent).  ",
      "- **Status:** Confirmed (the most recent CV, 5f8a8cabc2dbcf2a-cv.pdf, lists it as confirmed; personal questionnaire reiterates intent).  ",
    )
    .replace(
      "- **Status:** Previously evaluated, no longer under consideration (Alessio confirmed he is not interested in pursuing this option, June 2026). No mention of this option appears in the latest personal questionnaire.  ",
      "- **Status:** Previously evaluated, no longer under consideration. No mention of this option appears in the latest personal questionnaire.  ",
    )
    .replace(
      "1. The XJTU option has been deprioritised and is no longer under consideration (Alessio confirmed, June 2026).  ",
      "1. The XJTU option has been deprioritised and is no longer under consideration.  ",
    ),
);

edit("wiki/sources/8-carriera--2-cv--43-beige-simple-business-administration-resume--sy9m0o.md", (text) =>
  text.replace(
    "This is a resume for **Giulia Antonucci** (born 2008), a pastry student at **IPSSAR Ugo Tognazzi**. The document is stored in Alessio's CV folder. Alessio confirmed in June 2026 that Giulia is his sister and that the document should remain in the wiki as family-related context. It should not be used as evidence for Alessio's own education, work experience, or skills.",
    "This is a resume for **Giulia Antonucci** (born 2008), a pastry student at **IPSSAR Ugo Tognazzi**. The document is stored in Alessio's CV folder and remains in the wiki as family-related context for Alessio's sister. It should not be used as evidence for Alessio's own education, work experience, or skills.",
  ),
);

edit("wiki/experiences/index-2025-application.md", (text) =>
  text.replace(
    "- Alessio confirmed in June 2026 that he never received a response. If later correspondence is found, this page should be updated.",
    "- No response was received. If later correspondence is found, this page should be updated.",
  ),
);

console.log("Cleaned editorial confirmation notes.");
