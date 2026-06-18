import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMailRoot, canRead, enumerateEmlx } from "../src/locator.ts";

function fakeStore(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const root = join(home, "Library", "Mail", "V10");
  const msgs = join(root, "ACC-UUID", "INBOX.mbox", "BOX-UUID", "Data", "Messages");
  mkdirSync(msgs, { recursive: true });
  writeFileSync(join(msgs, "1.emlx"), "10\nfull-msg-1");
  writeFileSync(join(msgs, "2.partial.emlx"), "5\nstub2");
  return { home, root };
}

test("findMailRoot picks the V* dir; canRead true for readable", () => {
  const { home, root } = fakeStore();
  assert.equal(findMailRoot(home), root);
  assert.equal(canRead(root), true);
});

test("enumerateEmlx yields account, mailbox, isPartial", () => {
  const { root } = fakeStore();
  const entries = enumerateEmlx(root).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].account, "ACC-UUID");
  assert.equal(entries[0].mailbox, "INBOX");
  assert.equal(entries.find((e) => e.path.endsWith("2.partial.emlx"))!.isPartial, true);
  assert.equal(entries.find((e) => e.path.endsWith("1.emlx"))!.isPartial, false);
});
