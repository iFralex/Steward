import fs from "node:fs";
import path from "node:path";

const root = "/Users/alessioantonucci/Second Me/wiki";

const replacements = new Map([
  [
    "people/barbera-vincenzina.md",
    [
      [
        "Her role as course instructor was confirmed by Alessio Antonucci via phone call on 12 September 2024. No further biographical or professional details are available in the current source material.",
        "Her role as course instructor is tied to a phone-call note from 12 September 2024. No further biographical or professional details are available in the current source material.",
      ],
    ],
  ],
  [
    "people/sonia-marfoli.md",
    [
      [
        "- **Son:** [[alessio-antonucci]] (born 02/12/2004) — confirmed by Alessio in June 2026, by the INPS Handicap Certificate (2023) showing shared residence, and definitively by the Stato di Famiglia (2026).",
        "- **Son:** [[alessio-antonucci]] (born 02/12/2004) — relationship documented by the INPS Handicap Certificate (2023) showing shared residence and definitively by the Stato di Famiglia (2026).",
      ],
    ],
  ],
  [
    "people/giulia-antonucci.md",
    [
      [
        "Giulia Antonucci (fiscal code `NTNGLI08A48E472F`, born 8 January 2008 in Latina) is the sister of [[alessio-antonucci]]. The sibling relationship is confirmed by Alessio (June 2026), by a personal correspondence from 2 January 2023 sharing a chicken curry recipe (*Pollo al curry*), and by co‑ownership and inheritance records.",
        "Giulia Antonucci (fiscal code `NTNGLI08A48E472F`, born 8 January 2008 in Latina) is the sister of [[alessio-antonucci]]. The sibling relationship is documented by personal correspondence from 2 January 2023 sharing a chicken curry recipe (*Pollo al curry*) and by co‑ownership and inheritance records.",
      ],
    ],
  ],
]);

let changed = 0;
for (const [rel, pairs] of replacements) {
  const target = path.join(root, rel);
  let text = fs.readFileSync(target, "utf8");
  const before = text;
  for (const [from, to] of pairs) {
    text = text.replace(from, to);
  }
  if (text !== before) {
    fs.writeFileSync(target, text);
    changed++;
  }
}

console.log(`Updated ${changed} files.`);
