import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { BlobStore } from "../src/blobstore.ts";
import { ingestEmlxFile, bodyStateFor } from "../src/sync.ts";
import type { EmlxEntry } from "../src/types.ts";

function emlx(dir: string, name: string, rfc: string): string {
  const body = Buffer.from(rfc, "utf8");
  const buf = Buffer.concat([Buffer.from(String(body.length) + "\n"), body, Buffer.from("<plist></plist>\n")]);
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

const ROOT = (mid: string, extra = "") =>
  `From: A <a@x>\r\nTo: me@x\r\nSubject: Hello\r\nMessage-ID: <${mid}>\r\n${extra}Content-Type: text/plain\r\n\r\nbody ${mid}\r\n`;

test("bodyStateFor classifies", () => {
  assert.equal(bodyStateFor(false, "x"), "full");
  assert.equal(bodyStateFor(true, "x"), "partial");
  assert.equal(bodyStateFor(true, ""), "none");
});

test("ingest stores message and groups a reply into the same thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ing-"));
  const store = Store.open(":memory:");
  const blobs = new BlobStore(join(dir, "blobs"));
  const deps = { store, blobs };

  const e1: EmlxEntry = { path: emlx(dir, "1.emlx", ROOT("root@x")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 };
  const e2: EmlxEntry = { path: emlx(dir, "2.emlx", ROOT("reply@x", "In-Reply-To: <root@x>\r\nReferences: <root@x>\r\n")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 2 };

  const id1 = await ingestEmlxFile(deps, e1);
  const id2 = await ingestEmlxFile(deps, e2);
  assert.equal(id1, "root@x");
  assert.equal(id2, "reply@x");

  const t1 = store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("root@x") as { thread_id: number };
  const t2 = store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("reply@x") as { thread_id: number };
  assert.ok(t1.thread_id != null && t1.thread_id === t2.thread_id);
  store.close();
});
