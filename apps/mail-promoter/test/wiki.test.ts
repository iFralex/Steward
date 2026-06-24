// apps/mail-promoter/test/wiki.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promote, makeFsWikiPromoter } from "../src/wiki.ts";

test("promote calls addSources with the note and default project (rescan defaults true)", async () => {
  const calls: unknown[] = [];
  const client = { addSources: async (p: string, s: unknown, r?: boolean) => { calls.push([p, s, r]); return {}; } };
  await promote({ filename: "mail-x.md", content: "hi" }, client);
  assert.deepEqual(calls, [["current", [{ filename: "mail-x.md", content: "hi" }], true]]);
});

test("promote forwards rescan=false for bulk backfill", async () => {
  const calls: unknown[] = [];
  const client = { addSources: async (p: string, s: unknown, r?: boolean) => { calls.push(r); return {}; } };
  await promote({ filename: "mail-x.md", content: "hi" }, client, "current", false);
  assert.deepEqual(calls, [false]);
});

test("makeFsWikiPromoter writes the note straight to the sources dir", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "promoter-")), "raw", "sources");
  const fs = makeFsWikiPromoter(dir);
  await fs.addSources("current", [{ filename: "mail-x.md", content: "ciao" }]);
  assert.ok(existsSync(join(dir, "mail-x.md")));
  assert.equal(readFileSync(join(dir, "mail-x.md"), "utf8"), "ciao");
});
