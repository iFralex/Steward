#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/alessioantonucci/Second Me";
const rel = "wiki/projects/candidai-project.md";
const full = path.join(ROOT, rel);
let text = fs.readFileSync(full, "utf8").replace(/^updated: .+$/m, "updated: 2026-07-04");

const from = `## Current Status

As of the last known email correspondence (December 2025), CandidAI had no active payment processing following the Nexi termination. The partnership discussions with Valerio and uCV may or may not have progressed; no outcome is documented. The job-offer aggregator concept and multi‑niche landing pages remain unconfirmed as implemented.`;

const to = `## Current Status

CandidAI is online through [[candidai-tech]] and is currently in a marketing/user-acquisition phase, looking for paying users. The Nexi payment-processing track should still be treated as terminated unless a later replacement provider is documented.

The partnership discussions with Valerio/uCV and the job-offer aggregator concept remain unconfirmed as implemented. The Michele Bennati proposal and John Odunayo promo-video commission are closed as no-response tracks.`;

if (!text.includes(from)) throw new Error("Missing CandidAI current status block");
text = text.replace(from, to);
fs.writeFileSync(full, text);
console.log("Updated CandidAI current status.");
