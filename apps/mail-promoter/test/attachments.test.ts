import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../../mail-mirror/src/store.ts";
import { categoryForAttachment, syncThreadAttachments } from "../src/attachments.ts";

function message(id: string) {
  return {
    messageId: id, account: "A", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], toNames: [], ccNames: [], subject: "S", date: 1,
    bodyText: "body", bodyState: "full" as const, source: "emlx" as const,
    emlxPath: null, inReplyTo: null, references: [], gmThrid: null, size: 1,
    unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null,
  };
}

test("syncThreadAttachments copies ingestable unique blobs and skips signatures", () => {
  const root = mkdtempSync(join(tmpdir(), "mail-atts-"));
  const blobs = join(root, "blobs");
  const sources = join(root, "sources");
  const store = Store.open(":memory:");
  store.upsertMessage(message("m1"));
  store.upsertMessage(message("m2"));
  store.setThreadId("m1", 7);
  store.setThreadId("m2", 7);

  const pdfRel = "aa/hash-pdf";
  const sigRel = "bb/hash-sig";
  mkdirSync(dirname(join(blobs, pdfRel)), { recursive: true });
  mkdirSync(dirname(join(blobs, sigRel)), { recursive: true });
  const pdfContent = "%PDF-test-content-that-is-long-enough-for-ingest";
  writeFileSync(join(blobs, pdfRel), pdfContent);
  writeFileSync(join(blobs, sigRel), "signature");
  store.insertAttachments("m1", [
    { filename: "Report finale.pdf", mime: "application/pdf", size: pdfContent.length, sha256: "a".repeat(64), relPath: pdfRel, downloaded: true },
    { filename: "smime.p7s", mime: "application/pkcs7-signature", size: 9, sha256: "b".repeat(64), relPath: sigRel, downloaded: true },
  ]);
  store.insertAttachments("m2", [
    { filename: "Report finale.pdf", mime: "application/pdf", size: pdfContent.length, sha256: "a".repeat(64), relPath: pdfRel, downloaded: true },
  ]);

  const r = syncThreadAttachments({ store, threadId: 7, blobRoot: blobs, sourcesDir: sources });

  assert.equal(r.copied, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0].relativePath, "documenti/aaaaaaaaaaaaaaaa-Report-finale.pdf");
  assert.equal(readFileSync(join(sources, r.attachments[0].relativePath), "utf8"), pdfContent);
  assert.equal(existsSync(join(sources, "documenti", "bbbbbbbbbbbbbbbb-smime.p7s")), false);
  store.close();
});

test("categoryForAttachment separates CVs, letters and other documents", () => {
  assert.equal(categoryForAttachment("CV Google.pdf"), "cv");
  assert.equal(categoryForAttachment("cover-letter-google.pdf"), "lettere");
  assert.equal(categoryForAttachment("reference letter Sciuto.txt"), "lettere");
  assert.equal(categoryForAttachment("contratto.pdf"), "documenti");
});
