import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { backfill, reconcile } from "../src/sync.ts";

function store(root: string, acct: string, n: number, mid: string): string {
  const dir = join(root, acct, "INBOX.mbox", "B", "Data", "Messages");
  mkdirSync(dir, { recursive: true });
  const rfc = `From: A <a@x>\r\nSubject: S${n}\r\nMessage-ID: <${mid}>\r\nContent-Type: text/plain\r\n\r\nbody ${mid}\r\n`;
  const body = Buffer.from(rfc);
  const p = join(dir, `${n}.emlx`);
  writeFileSync(p, Buffer.concat([Buffer.from(String(body.length) + "\n"), body, Buffer.from("<plist></plist>\n")]));
  return p;
}

test("backfill ingests all; reconcile adds new and soft-deletes removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "root-"));
  const s = Store.open(":memory:");
  const deps = { store: s, blobs: new BlobStore(join(root, "blobs")) };
  const p1 = store(root, "ACC", 1, "a@x");
  store(root, "ACC", 2, "b@x");

  const bf = await backfill(deps, root);
  assert.equal(bf.ingested, 2);
  assert.ok(s.getMessage("a@x") && s.getMessage("b@x"));

  store(root, "ACC", 3, "c@x"); // new file
  rmSync(p1); // removed file
  const rc = await reconcile(deps, root);
  assert.equal(rc.ingested, 1); // c@x
  assert.equal(rc.deleted, 1); // a@x
  const a = s.raw.prepare("SELECT deleted FROM messages WHERE message_id=?").get("a@x") as { deleted: number };
  assert.equal(a.deleted, 1);
  s.close();
});
