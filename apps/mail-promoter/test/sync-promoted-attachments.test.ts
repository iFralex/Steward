import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../../mail-mirror/src/store.ts";
import { PromoteState } from "../src/state.ts";
import { syncPromotedThreadAttachments } from "../src/sync-promoted-attachments.ts";

test("syncPromotedThreadAttachments patches existing notes without changing promotion state", () => {
  const root = mkdtempSync(join(tmpdir(), "promoted-atts-"));
  const blobs = join(root, "blobs");
  const sources = join(root, "sources");
  mkdirSync(sources, { recursive: true });
  const store = Store.open(":memory:");
  store.upsertMessage({
    messageId: "m", account: "A", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], toNames: [], ccNames: [], subject: "S", date: 1,
    bodyText: "body", bodyState: "full", source: "emlx", emlxPath: null,
    inReplyTo: null, references: [], gmThrid: null, size: 1, unread: false,
    flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null,
  });
  store.setThreadId("m", 8);
  const rel = "aa/blob";
  mkdirSync(dirname(join(blobs, rel)), { recursive: true });
  const pdfContent = "%PDF-test-content-that-is-long-enough-for-ingest";
  writeFileSync(join(blobs, rel), pdfContent);
  store.insertAttachments("m", [
    { filename: "contract.pdf", mime: "application/pdf", size: pdfContent.length, sha256: "c".repeat(64), relPath: rel, downloaded: true },
  ]);
  const state = PromoteState.open(":memory:");
  state.record({
    messageId: "thread:8", decision: "promoted", categories: ["document"],
    classifyModel: "tier-5", distillModel: "tier-5",
    wikiFilename: "mail-thread-8.md", sourceHash: "original-hash",
  });
  writeFileSync(join(sources, "mail-thread-8.md"), "---\nthread: thread://8\n---\nSummary\n");

  const r = syncPromotedThreadAttachments({ store, state, blobRoot: blobs, sourcesDir: sources });

  assert.equal(r.notesUpdated, 1);
  assert.equal(r.attachmentsLinked, 1);
  const note = readFileSync(join(sources, "mail-thread-8.md"), "utf8");
  assert.match(note, /attachments: \[documenti\/cccccccccccccccc-contract\.pdf\]/);
  assert.match(note, /## Attachments/);
  assert.match(note, /\[contract\.pdf\]\(documenti\/cccccccccccccccc-contract\.pdf\)/);
  assert.equal(state.getRecord("thread:8")?.sourceHash, "original-hash");
  store.close();
  state.close();
});
