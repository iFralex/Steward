import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInsideDir, withDestinationPrefix, planForChosenPath } from "../src/core.ts";

function fixture(): { dir: string; sources: string } {
  const dir = mkdtempSync(join(tmpdir(), "wiki-add-dest-"));
  const sources = join(dir, "raw", "sources");
  mkdirSync(sources, { recursive: true });
  return { dir, sources };
}

test("isInsideDir: nested path is inside root", () => {
  const { sources } = fixture();
  assert.equal(isInsideDir(sources, join(sources, "progetti", "foo.pdf")), true);
});

test("isInsideDir: root itself counts as inside", () => {
  const { sources } = fixture();
  assert.equal(isInsideDir(sources, sources), true);
});

test("isInsideDir: sibling path with shared prefix text is NOT inside", () => {
  const { dir, sources } = fixture();
  mkdirSync(sources + "-other", { recursive: true });
  assert.equal(isInsideDir(sources, sources + "-other"), false);
});

test("isInsideDir: a parent of root is NOT inside", () => {
  const { dir, sources } = fixture();
  assert.equal(isInsideDir(sources, dir), false);
});

test("withDestinationPrefix prefixes every targetRel", () => {
  const plans = [{ src: "/a", targetRel: "one.pdf" }, { src: "/b", targetRel: "sub/two.pdf" }];
  const result = withDestinationPrefix(plans, "progetti/foo");
  assert.deepEqual(result.map((p) => p.targetRel), ["progetti/foo/one.pdf", "progetti/foo/sub/two.pdf"]);
});

test("withDestinationPrefix leaves targetRel unchanged when prefix is empty", () => {
  const plans = [{ src: "/a", targetRel: "one.pdf" }];
  assert.deepEqual(withDestinationPrefix(plans, ""), plans);
});

test("planForChosenPath: single file uses the chosen path directly as targetRel", () => {
  const { dir, sources } = fixture();
  writeFileSync(join(dir, "report.pdf"), "x");
  const chosen = join(sources, "progetti", "renamed.pdf");
  const plans = planForChosenPath(join(dir, "report.pdf"), chosen, sources);
  assert.deepEqual(plans, [{ src: join(dir, "report.pdf"), targetRel: "progetti/renamed.pdf" }]);
});

test("planForChosenPath: single folder mirrors structure under the chosen path", () => {
  const { dir, sources } = fixture();
  mkdirSync(join(dir, "Proj", "sub"), { recursive: true });
  writeFileSync(join(dir, "Proj", "a.md"), "x");
  writeFileSync(join(dir, "Proj", "sub", "b.pdf"), "x");
  const chosen = join(sources, "progetti", "Renamed");
  const plans = planForChosenPath(join(dir, "Proj"), chosen, sources);
  assert.deepEqual(
    plans.map((p) => p.targetRel).sort(),
    ["progetti/Renamed/a.md", "progetti/Renamed/sub/b.pdf"],
  );
});
