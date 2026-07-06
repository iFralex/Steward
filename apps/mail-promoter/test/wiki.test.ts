// apps/mail-promoter/test/wiki.test.ts
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempAuditDir } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as joinPath } from "node:path";
process.env.AUDIT_DIR = mkdtempAuditDir(joinPath(osTmpdir(), "mail-promoter-audit-test-"));
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promote, makeFsWikiPromoter } from "../src/wiki.ts";
import { auditLog } from "@steward/audit-log";

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

test("filesystem promotion atomically replaces canonical note and removes old filename", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "promoter-")), "raw", "sources");
  const fs = makeFsWikiPromoter(dir);
  writeFileSync(join(dir, "mail-old.md"), "old");

  await promote({ filename: "mail-thread-7.md", content: "new" }, fs, "current", false, "mail-old.md");

  assert.equal(readFileSync(join(dir, "mail-thread-7.md"), "utf8"), "new");
  assert.equal(existsSync(join(dir, "mail-old.md")), false);
});

test("promote audits a successful write as actor 'scheduler', with the note content snippeted (not stored in full)", async () => {
  const client = { addSources: async () => ({}) };
  const longBody = "x".repeat(500);
  await promote({ filename: "mail-audit-1.md", content: longBody }, client);
  const event = auditLog().query({ eventType: "wiki.promoted" }).events.find((e) => e.summary.includes("mail-audit-1.md"));
  assert.equal(event?.actor, "scheduler");
  assert.equal(event?.ok, true);
  const payload = event?.redactedPayloadJson as Record<string, unknown>;
  assert.equal(payload.filename, "mail-audit-1.md");
  assert.ok((payload.content as string).length <= 120, "the wiki note body must not be stored in full");
});

test("promote audits a failed write and still throws (audit is additive, not a control-flow change)", async () => {
  const client = { addSources: async () => { throw new Error("wiki API unreachable"); } };
  await assert.rejects(() => promote({ filename: "mail-audit-2.md", content: "hi" }, client), /wiki API unreachable/);
  const event = auditLog().query({ eventType: "wiki.promote_failed" }).events.find((e) => e.summary === "wiki API unreachable");
  assert.equal(event?.actor, "scheduler");
  assert.equal(event?.ok, false);
});
