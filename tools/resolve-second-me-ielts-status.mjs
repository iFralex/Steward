#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/alessioantonucci/Second Me";
const TODAY = "2026-07-04";

function p(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(p(rel), "utf8");
}

function write(rel, text) {
  fs.writeFileSync(p(rel), text);
}

function setUpdated(text) {
  return text.replace(/^updated: .+$/m, `updated: ${TODAY}`);
}

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Missing expected text: ${label}`);
  return text.replace(from, to);
}

{
  const rel = "wiki/events/ielts-accessibility-request-2026.md";
  let text = setUpdated(read(rel));
  text = text.replace("status: uncertain", "status: partially-resolved");
  text = mustReplace(
    text,
    "Alessio Antonucci requested special arrangements for the IELTS Academic test due to his legal blindness and guide‑dog use. The request was directed to the British Council Italy on 17 March 2026 (reference CS‑27830365). British Council specified that Special Arrangements require IELTS on Paper and that the medical certification (Legge 104) must be uploaded at least six weeks before the test date. Alessio attached his Verbale definitivo.pdf certification. The request was forwarded to the exams office for evaluation. The outcome – approval, test date, and location – is not yet documented.",
    `Alessio Antonucci requested special arrangements for the IELTS Academic test due to his legal blindness and guide-dog use. The request was directed to the British Council Italy on 17 March 2026 (reference CS-27830365). British Council specified that Special Arrangements require IELTS on Paper and that the medical certification (Legge 104) must be uploaded at least six weeks before the test date. Alessio attached his Verbale definitivo.pdf certification. The request was forwarded to the exams office for evaluation.

Later records show that Alessio obtained an IELTS Academic score of **7.5** by 24 June 2026 ([[mail-thread-177]]), so the open question "did he complete IELTS / receive a score?" is resolved. The administrative outcome of the March accessibility request itself - exact approval message, final test logistics, and any detailed accommodation decision - is not separately documented in this thread.`,
    "IELTS accessibility event body",
  );
  write(rel, text);
}

{
  const rel = "wiki/events/ielts-academic-exam-june-2026.md";
  let text = setUpdated(read(rel));
  text = text.replace('sources: ["mail-thread-296.md"]', 'sources: ["mail-thread-296.md", "mail-thread-177.md"]');
  text = mustReplace(
    text,
    "The exam took place as scheduled. Alessio's results are not documented in the source material.",
    "The exam took place as scheduled. By 24 June 2026, Alessio reported an IELTS Academic score of **7.5** in [[mail-thread-177]], equivalent to a strong C1-level English certification.",
    "IELTS exam outcome",
  );
  write(rel, text);
}

{
  const rel = "wiki/topics/ielts-accessibility-request-2026.md";
  let text = setUpdated(read(rel));
  text = text.replace('sources: ["mail-thread-15690.md", "mail-thread-1747.md"]', 'sources: ["mail-thread-15690.md", "mail-thread-1747.md", "mail-thread-177.md"]');
  write(rel, text);
}

{
  const reviewPath = p(".llm-wiki/review.json");
  const data = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  const ids = new Set(["review-170", "review-172", "review-174", "review-523", "review-585"]);
  const notes = {
    "review-170": "IELTS follow-up resolved at certification-status level: IELTS Academic 7.5 documented by 24 Jun 2026; detailed accessibility-request approval remains not separately documented.",
    "review-172": "IELTS completion/score resolved via later source; administrative approval/logistics not separately documented.",
    "review-174": "Role clarified: initial EIT submission used the alternative B2 pathway; later IELTS 7.5 provided formal English certification after submission.",
    "review-523": "IELTS result recorded as 7.5 by 24 Jun 2026.",
    "review-585": "Overview/event claim no longer unsupported in wiki context: IELTS Academic June 2026 event and later 7.5 result are documented; exact accommodation approval remains source-scoped.",
  };
  const now = new Date().toISOString();
  for (const item of data) {
    if (ids.has(item.id)) {
      item.resolved = true;
      item.resolvedAt = now;
      item.resolution = notes[item.id];
      ids.delete(item.id);
    }
  }
  if (ids.size) throw new Error(`Missing review ids: ${[...ids].join(", ")}`);
  fs.writeFileSync(reviewPath, JSON.stringify(data, null, 2) + "\n");
}

console.log("Resolved IELTS status batch.");
