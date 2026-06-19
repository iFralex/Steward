// apps/mail-mirror/test/sync-enrich.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { ingestEmlxFile } from "../src/sync.ts";

test("ingest carries flags and recipient names from the emlx", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-enrich-"));
  const raw =
    "From: A <a@x.com>\r\nTo: Cristiana Rossi <cris@x.com>\r\nMessage-ID: <m1@x>\r\nSubject: hi\r\n\r\nbody\r\n";
  // flags 8590195856 = flagged, not read → unread=true, flagged=true
  const emlx = `${Buffer.byteLength(raw)}\n${raw}<plist version="1.0"><dict><key>flags</key><integer>8590195856</integer></dict></plist>\n`;
  const path = join(dir, "1.emlx");
  writeFileSync(path, emlx);
  const store = Store.open(":memory:");
  const blobs = new BlobStore(join(dir, "blobs"));
  await ingestEmlxFile({ store, blobs }, { path, account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 });
  const m = store.getMessage("m1@x")!;
  assert.equal(m.unread, true);
  assert.equal(m.flagged, true);
  assert.deepEqual(m.toNames, ["Cristiana Rossi"]);
  store.close();
});
