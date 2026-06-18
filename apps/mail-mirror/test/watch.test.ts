import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { startWatch } from "../src/watch.ts";

const emlxBuf = (mid: string) => {
  const rfc = `From: A <a@x>\r\nSubject: S\r\nMessage-ID: <${mid}>\r\nContent-Type: text/plain\r\n\r\nbody\r\n`;
  const body = Buffer.from(rfc);
  return Buffer.concat([Buffer.from(String(body.length) + "\n"), body, Buffer.from("<plist></plist>\n")]);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("watcher ingests new files and soft-deletes removed ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "watch-"));
  const msgs = join(root, "ACC", "INBOX.mbox", "B", "Data", "Messages");
  mkdirSync(msgs, { recursive: true });
  const s = Store.open(":memory:");
  const w = startWatch({ store: s, blobs: new BlobStore(join(root, "blobs")) }, root);
  await wait(300);

  const p = join(msgs, "1.emlx");
  writeFileSync(p, emlxBuf("w1@x"));
  for (let i = 0; i < 40 && !s.getMessage("w1@x"); i++) await wait(100);
  assert.ok(s.getMessage("w1@x"), "ingested on add");

  rmSync(p);
  let del = 0;
  for (let i = 0; i < 40 && del === 0; i++) {
    await wait(100);
    const r = s.raw.prepare("SELECT deleted FROM messages WHERE message_id=?").get("w1@x") as { deleted: number };
    del = r?.deleted ?? 0;
  }
  assert.equal(del, 1, "soft-deleted on unlink");
  await w.close();
  s.close();
});
