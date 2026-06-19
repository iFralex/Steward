// apps/mail-mirror/test/sync-mtime.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { reconcile } from "../src/sync.ts";

function emlx(flagsInt: number): string {
  const raw = "From: a@x\r\nTo: b@x\r\nMessage-ID: <m1@x>\r\nSubject: s\r\n\r\nbody\r\n";
  return `${Buffer.byteLength(raw)}\n${raw}<plist><dict><key>flags</key><integer>${flagsInt}</integer></dict></plist>\n`;
}

test("reconcile re-ingests an emlx whose mtime advanced (flag change propagates)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-mtime-"));
  // Lay out a realistic V10/<acct>/INBOX.mbox/<uuid>/Data/.../1.emlx so the locator assigns account+mailbox.
  const root = join(dir, "V10");
  const box = join(root, "ACC", "INBOX.mbox", "U", "Data");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(box, { recursive: true });
  const path = join(box, "1.emlx");
  writeFileSync(path, emlx(8590195840)); // unread, not flagged
  const store = Store.open(":memory:");
  const blobs = new BlobStore(join(dir, "blobs"));
  await reconcile({ store, blobs }, root);
  assert.equal(store.getMessage("m1@x")!.flagged, false);

  writeFileSync(path, emlx(8590195856)); // now flagged
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // bump mtime forward
  await reconcile({ store, blobs }, root);
  assert.equal(store.getMessage("m1@x")!.flagged, true);
  store.close();
});
