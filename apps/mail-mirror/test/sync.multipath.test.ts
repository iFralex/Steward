import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { ingestEmlxFile, reconcile } from "../src/sync.ts";
import type { EmlxEntry } from "../src/types.ts";

function emlx(dir: string, name: string, rfc: string): string {
  const body = Buffer.from(rfc, "utf8");
  const buf = Buffer.concat([Buffer.from(String(body.length) + "\n"), body, Buffer.from("<plist></plist>\n")]);
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

const RFC = (mid: string) =>
  `From: A <a@x>\r\nTo: me@x\r\nSubject: Hello\r\nMessage-ID: <${mid}>\r\nContent-Type: text/plain\r\n\r\nbody ${mid}\r\n`;

test("same Message-ID at two paths: one messages row, two message_paths rows; soft-delete only when no path remains", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-"));
  const store = Store.open(":memory:");
  const deps = { store, blobs: new BlobStore(join(dir, "blobs")) };

  const p1 = emlx(dir, "a.emlx", RFC("dup@x"));
  const p2 = emlx(dir, "b.emlx", RFC("dup@x"));
  const e1: EmlxEntry = { path: p1, account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 };
  const e2: EmlxEntry = { path: p2, account: "ACC", mailbox: "Tutti i messaggi", isPartial: false, mtimeMs: 2 };

  await ingestEmlxFile(deps, e1);
  await ingestEmlxFile(deps, e2);

  const rows = store.raw.prepare("SELECT COUNT(*) AS c FROM messages WHERE message_id=?").get("dup@x") as { c: number };
  assert.equal(rows.c, 1, "exactly one messages row");
  assert.equal(store.pathsForMessage("dup@x").length, 2, "two message_paths rows");

  // reconcile uses the real on-disk paths; only one removed -> not soft-deleted.
  // Need the locator to see these files; instead drive reconcile against a real root.
  rmSync(p1);
  // mailRoot here is dir; enumerateEmlx will only find p2 (p1 removed). p1 path no longer on disk.
  const rc1 = await reconcile(deps, dir);
  assert.equal(rc1.deleted, 0, "not soft-deleted while another path remains");
  const d1 = store.raw.prepare("SELECT deleted FROM messages WHERE message_id=?").get("dup@x") as { deleted: number };
  assert.equal(d1.deleted, 0);

  rmSync(p2);
  const rc2 = await reconcile(deps, dir);
  assert.equal(rc2.deleted, 1, "soft-deleted once last path is gone");
  const d2 = store.raw.prepare("SELECT deleted FROM messages WHERE message_id=?").get("dup@x") as { deleted: number };
  assert.equal(d2.deleted, 1);
  store.close();
});

test("mailbox precedence: All-Mail copy does not overwrite a specific mailbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mbp-"));
  const store = Store.open(":memory:");
  const deps = { store, blobs: new BlobStore(join(dir, "blobs")) };

  const e1: EmlxEntry = { path: emlx(dir, "1.emlx", RFC("box@x")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 };
  const e2: EmlxEntry = { path: emlx(dir, "2.emlx", RFC("box@x")), account: "ACC", mailbox: "Tutti i messaggi", isPartial: false, mtimeMs: 2 };

  await ingestEmlxFile(deps, e1);
  await ingestEmlxFile(deps, e2);

  const m = store.getMessage("box@x");
  assert.equal(m?.mailbox, "INBOX", "specific mailbox is retained over All-Mail");
  store.close();
});
