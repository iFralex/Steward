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
  // The source mtime stays identical: only the extractor version is stale.
  store.raw.prepare("UPDATE messages SET body_text='old placeholder', body_extraction=NULL WHERE message_id='m1@x'").run();
  await reconcile({ store, blobs }, root);
  assert.equal(store.getMessage("m1@x")!.bodyText, "body");
  assert.equal(store.getMessage("m1@x")!.bodyExtraction?.version, 2);

  writeFileSync(path, emlx(8590195856)); // now flagged
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // bump mtime forward
  await reconcile({ store, blobs }, root);
  assert.equal(store.getMessage("m1@x")!.flagged, true);
  store.close();
});

test("reconcile re-extracts a stale message from its surviving registered path", async () => {
  const { mkdirSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "mm-stale-alternate-"));
  const root = join(dir, "V10");
  const box = join(root, "ACC", "INBOX.mbox", "U", "Data");
  mkdirSync(box, { recursive: true });
  const a = join(box, "1.emlx"), b = join(box, "2.emlx");
  writeFileSync(a, emlx(0)); writeFileSync(b, emlx(0));
  const store = Store.open(":memory:");
  try {
    const deps = { store, blobs: new BlobStore(join(dir, "blobs")) };
    await reconcile(deps, root);
    const primary = store.getMessage("m1@x")!.emlxPath!;
    const surviving = primary === a ? b : a;
    rmSync(primary);
    store.raw.prepare("UPDATE messages SET body_text='old placeholder', body_extraction=NULL WHERE message_id='m1@x'").run();
    const result = await reconcile(deps, root);
    assert.equal(result.ingested, 1);
    assert.equal(store.getMessage("m1@x")!.bodyText, "body");
    assert.equal(store.getMessage("m1@x")!.bodyExtraction?.version, 2);
    assert.equal(store.getMessage("m1@x")!.emlxPath, surviving);
    assert.equal(store.pathsForMessage("m1@x").length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reconcile does not replace a full stale body with only a partial alternate", async () => {
  const { mkdirSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "mm-stale-partial-"));
  const root = join(dir, "V10"), box = join(root, "ACC", "INBOX.mbox", "U", "Data");
  mkdirSync(box, { recursive: true });
  const full = join(box, "1.emlx"), partial = join(box, "2.partial.emlx");
  writeFileSync(full, emlx(0));
  const store = Store.open(":memory:");
  try {
    const deps = { store, blobs: new BlobStore(join(dir, "blobs")) };
    await reconcile(deps, root);
    writeFileSync(partial, emlx(0));
    store.recordPath("m1@x", partial, "INBOX", true, (await import("node:fs")).statSync(partial).mtimeMs);
    rmSync(full);
    store.raw.prepare("UPDATE messages SET body_text='complete preserved body', body_state='full', body_extraction=NULL WHERE message_id='m1@x'").run();
    assert.equal((await reconcile(deps, root)).ingested, 0);
    assert.equal(store.getMessage("m1@x")!.bodyText, "complete preserved body");
    assert.equal(store.getMessage("m1@x")!.bodyState, "full");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
