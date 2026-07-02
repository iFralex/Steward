import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkIngestible, planFromInputs, planFromRoot, applyPlans } from "../src/core.ts";

function fixture(): { dir: string; project: string; sources: string } {
  const dir = mkdtempSync(join(tmpdir(), "wiki-add-"));
  const project = mkdtempSync(join(tmpdir(), "wiki-proj-"));
  const sources = join(project, "raw", "sources");
  mkdirSync(sources, { recursive: true });
  return { dir, project, sources };
}

test("walkIngestible collects ingestible files, skipping junk + hidden", () => {
  const { dir } = fixture();
  writeFileSync(join(dir, "a.pdf"), "x");
  writeFileSync(join(dir, ".hidden.md"), "x");
  writeFileSync(join(dir, "photo.png"), "x");
  writeFileSync(join(dir, "video.mov"), "x"); // not ingestible
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "b.md"), "x");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "junk.js"), "x");

  const found = walkIngestible(dir).map((p) => p.replace(dir + "/", "")).sort();
  assert.deepEqual(found, ["a.pdf", "photo.png", "sub/b.md"]);
});

test("planFromInputs mirrors folders and flattens loose files", () => {
  const { dir } = fixture();
  mkdirSync(join(dir, "Proj", "sub"), { recursive: true });
  writeFileSync(join(dir, "Proj", "a.md"), "x");
  writeFileSync(join(dir, "Proj", "sub", "b.pdf"), "x");
  writeFileSync(join(dir, "loose.txt"), "x");

  const plans = planFromInputs([join(dir, "Proj"), join(dir, "loose.txt")]);
  const rels = plans.map((p) => p.targetRel).sort();
  assert.deepEqual(rels, ["Proj/a.md", "Proj/sub/b.pdf", "loose.txt"]);
});

test("planFromRoot mirrors picked files relative to the root folder", () => {
  const { dir } = fixture();
  mkdirSync(join(dir, "Proj", "sub"), { recursive: true });
  writeFileSync(join(dir, "Proj", "sub", "b.pdf"), "x");
  const plans = planFromRoot([join(dir, "Proj", "sub", "b.pdf")], join(dir, "Proj"));
  assert.deepEqual(plans.map((p) => p.targetRel), ["Proj/sub/b.pdf"]);
});

test("applyPlans copies into sources, and re-adding the same origin updates (no duplicate)", () => {
  const { dir, project, sources } = fixture();
  writeFileSync(join(dir, "a.pdf"), "v1");

  const first = applyPlans(planFromInputs([join(dir, "a.pdf")]), sources, project);
  assert.equal(first.added.length, 1);
  assert.equal(first.updated.length, 0);
  assert.ok(existsSync(join(sources, "a.pdf")));

  // Edit the origin and re-add → same target overwritten, counted as update.
  writeFileSync(join(dir, "a.pdf"), "v2");
  const second = applyPlans(planFromInputs([join(dir, "a.pdf")]), sources, project);
  assert.equal(second.added.length, 0);
  assert.equal(second.updated.length, 1);
  assert.equal(readFileSync(join(sources, "a.pdf"), "utf8"), "v2");
});

test("applyPlans avoids collisions across different origins with the same name", () => {
  const { dir, project, sources } = fixture();
  mkdirSync(join(dir, "one"));
  mkdirSync(join(dir, "two"));
  writeFileSync(join(dir, "one", "report.pdf"), "1");
  writeFileSync(join(dir, "two", "report.pdf"), "2");

  const res = applyPlans(
    [{ src: join(dir, "one", "report.pdf"), targetRel: "report.pdf" }, { src: join(dir, "two", "report.pdf"), targetRel: "report.pdf" }],
    sources, project,
  );
  assert.equal(res.added.length, 2);
  assert.ok(existsSync(join(sources, "report.pdf")));
  assert.ok(existsSync(join(sources, "report (2).pdf")));
});
