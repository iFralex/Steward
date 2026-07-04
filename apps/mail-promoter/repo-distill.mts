// One curated wiki note per software project — from README + docs + git stats +
// stack (never the code). Writes project-<slug>.md into the wiki sources dir.
// Run: node --import tsx repo-distill.mts
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { gatewayChat } from "./src/llm.ts";
import { extractJson } from "../llm-gateway/src/extract-json.ts";

const REPOS: { path: string; extraDocs?: string[] }[] = [
  { path: "/Users/alessioantonucci/Progetti/CandidAI", extraDocs: ["TECHNICAL_DOCS.md", "documentazione.md", "site/src/app/docs/_content/complete-platform-documentation.ts"] },
  { path: "/Users/alessioantonucci/Downloads/VoiceFlow" },
  { path: "/Users/alessioantonucci/Downloads/ing-sw-2026-tauro-bartolucci-pedrotti-antonucci" },
  { path: "/Users/alessioantonucci/Downloads/telegram_mt5_bot" },
  { path: "/Users/alessioantonucci/Progetti/HelmStudio" },
  { path: "/Users/alessioantonucci/Progetti/Unica/ecommerce" },
  { path: "/Users/alessioantonucci/Downloads/ielts liz" },
  { path: "/Users/alessioantonucci/Downloads/a-bay" },
  { path: "/Users/alessioantonucci/Downloads/LeTreStelleFarm" },
  { path: "/Users/alessioantonucci/Progetti/flipping-inventory" },
  { path: "/Users/alessioantonucci/Downloads/website-design" },
  { path: "/Users/alessioantonucci/Progetti/YoutuberAI" },
  { path: "/Users/alessioantonucci/Progetti/crispyByte" },
];

const SOURCES = "/Users/alessioantonucci/Second Me/raw/sources/progetti";
mkdirSync(SOURCES, { recursive: true });
const chat = gatewayChat({ endpoint: "http://127.0.0.1:4000/v1/chat/completions", model: "tier-5" });

const Q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const sh = (cmd: string) => { try { return execSync(cmd, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const read = (p: string, max = 3500) => { try { return readFileSync(p, "utf8").slice(0, max); } catch { return ""; } };

function context(repo: string, extraDocs: string[] = []): { ctx: string; lastIso: string } {
  const last = sh(`git -C ${Q(repo)} log -1 --format=%cd --date=short`);
  const lastIso = sh(`git -C ${Q(repo)} log -1 --format=%cI`);
  const first = sh(`git -C ${Q(repo)} log --reverse --format=%cd --date=short`).split("\n")[0] ?? "";
  const n = sh(`git -C ${Q(repo)} rev-list --count HEAD`);
  const remote = sh(`git -C ${Q(repo)} config --get remote.origin.url`);
  const files = sh(`git -C ${Q(repo)} ls-files`).split("\n").filter(Boolean);
  const exts: Record<string, number> = {};
  for (const f of files) { const e = f.includes(".") ? f.split(".").pop()! : ""; if (e && e.length < 6) exts[e] = (exts[e] || 0) + 1; }
  const langs = Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, c]) => `${e}:${c}`).join(", ");
  const readme = read(join(repo, "README.md")) || read(join(repo, "readme.md")) || read(join(repo, "README"));
  const docFiles = files.filter((f) => (/^[^/]*\.(md|mdx)$/i.test(f) && /doc|technical|architecture|documentazione/i.test(f)) || /^docs\/.*\.(md|mdx)$/i.test(f)).slice(0, 4);
  let docs = "";
  for (const d of docFiles) docs += `\n--- ${d} ---\n${read(join(repo, d), 2200)}`;
  for (const e of extraDocs) docs += `\n--- ${e} ---\n${read(join(repo, e), 4500)}`;
  const pkg = read(join(repo, "package.json"), 1800);
  const reqs = read(join(repo, "requirements.txt"), 800) + read(join(repo, "pyproject.toml"), 800);
  const fileList = files.slice(0, 220).join("\n");
  const ctx = `REPO: ${basename(repo)}\nremote: ${remote}\ncommits: ${n} | period: ${first}..${last}\nlanguages: ${langs}\n\n=README=\n${readme || "(none)"}\n\n=DOCS=\n${docs || "(none)"}\n\n=package.json/reqs=\n${pkg}\n${reqs}\n\n=FILES=\n${fileList}`.slice(0, 16000);
  return { ctx, lastIso };
}

const SYSTEM =
  `You document the user's OWN software projects for their long-term personal memory. ` +
  `From the repo material (README, docs, git stats, stack, file list) produce ONLY JSON: ` +
  `{"summary": string, "stack": string[], "status": string, "role": string, "highlights": string[], "categories": string[]}. ` +
  `summary: 2-4 sentences — what it is, for whom/why. stack: key technologies/frameworks. ` +
  `status: one of "active","paused","archived","prototype" inferred from commit recency and count. ` +
  `role: the user's role if discernible (e.g. solo developer, team project, university project). ` +
  `highlights: notable features/achievements. categories ⊆ ["project"]. ` +
  `Be faithful; if something is unclear, omit it — do not invent.`;

const sec = (t: string, items: unknown) => (Array.isArray(items) && items.length ? `\n## ${t}\n${items.map((i) => `- ${i}`).join("\n")}\n` : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

let ok = 0;
for (const r of REPOS) {
  const name = basename(r.path);
  const { ctx, lastIso } = context(r.path, r.extraDocs);
  let out: string;
  try { out = await chat(SYSTEM, `Project: ${name}\n\n${ctx}`); } catch (e) { console.log(`SKIP ${name}: ${(e as Error).message}`); continue; }
  let p: Record<string, unknown>;
  try { p = extractJson(out) as Record<string, unknown>; } catch { console.log(`SKIP ${name}: unparseable`); continue; }
  if (typeof p.summary !== "string" || !p.summary.trim()) { console.log(`SKIP ${name}: no summary`); continue; }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const cats = strs(p.categories).length ? strs(p.categories) : ["project"];
  const fm = ["---", `source: file://${r.path}`, "type: software-project", `date: ${lastIso}`, `repo: ${name}`, `categories: [${cats.join(", ")}]`, "---", ""].join("\n");
  const body = `${p.summary}\n` + sec("Stack", p.stack) + (typeof p.status === "string" ? `\n## Status\n${p.status}\n` : "") + (typeof p.role === "string" ? `\n## Role\n${p.role}\n` : "") + sec("Highlights", p.highlights);
  writeFileSync(join(SOURCES, `project-${slug}.md`), fm + body);
  console.log(`✓ ${name}: ${p.summary.slice(0, 80)}`);
  ok++;
}
console.log(`\n${ok}/${REPOS.length} project notes written to ${SOURCES}`);
