import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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

const RFC2 = (mid: string, subject: string, extra = "") =>
  `From: A <a@x>\r\nTo: me@x\r\nSubject: ${subject}\r\nMessage-ID: <${mid}>\r\n${extra}Content-Type: text/plain\r\n\r\nbody ${mid}\r\n`;

test("gm_thrid groups two messages with no references and different subjects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ing-gm-"));
  const store = Store.open(":memory:");
  const deps = { store, blobs: new BlobStore(join(dir, "blobs")) };

  const e1: EmlxEntry = { path: emlx(dir, "1.emlx", RFC2("g1@x", "Alpha", "X-GM-THRID: 12345\r\n")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 };
  const e2: EmlxEntry = { path: emlx(dir, "2.emlx", RFC2("g2@x", "Beta", "X-GM-THRID: 12345\r\n")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 2 };

  await ingestEmlxFile(deps, e1);
  await ingestEmlxFile(deps, e2);

  const t1 = store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("g1@x") as { thread_id: number };
  const t2 = store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("g2@x") as { thread_id: number };
  assert.ok(t1.thread_id != null && t1.thread_id === t2.thread_id, "shared gm_thrid groups into one thread");
  store.close();
});

test("re-ingesting a no-subject no-references message reuses its own thread (no orphan threads)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ing-own-"));
  const store = Store.open(":memory:");
  const deps = { store, blobs: new BlobStore(join(dir, "blobs")) };

  const e1: EmlxEntry = { path: emlx(dir, "1.emlx", RFC2("own@x", "")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 };

  await ingestEmlxFile(deps, e1);
  const t1 = (store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("own@x") as { thread_id: number }).thread_id;
  await ingestEmlxFile(deps, e1);
  const t2 = (store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("own@x") as { thread_id: number }).thread_id;

  assert.equal(t1, t2, "re-ingest reuses own thread");
  const threadCount = store.raw.prepare("SELECT COUNT(*) AS c FROM threads").get() as { c: number };
  assert.equal(threadCount.c, 1, "no orphan empty threads created on re-ingest");
  store.close();
});

test("resolveThreadId escapes % in the subject LIKE pattern (unrelated subjects must not merge)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ing-like-"));
  const store = Store.open(":memory:");
  const deps = { store, blobs: new BlobStore(join(dir, "blobs")) };

  // Same participants (a@x / me@x) so the only gate left is the subject LIKE match.
  // Unescaped, subj2's literal "%" becomes a wildcard: the stored pattern
  // "%Alpha%Bravo%" would match subj1 ("Alpha ... Bravo ...") even though the
  // two subjects share no real relationship — a false thread merge.
  const e1: EmlxEntry = { path: emlx(dir, "1.emlx", RFC2("pctA@x", "Alpha report Bravo section")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 };
  const e2: EmlxEntry = { path: emlx(dir, "2.emlx", RFC2("pctB@x", "Alpha%Bravo")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 2 };

  await ingestEmlxFile(deps, e1);
  await ingestEmlxFile(deps, e2);

  const t1 = (store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("pctA@x") as { thread_id: number }).thread_id;
  const t2 = (store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("pctB@x") as { thread_id: number }).thread_id;
  assert.notEqual(t1, t2, "a literal % in one subject must not wildcard-match an unrelated subject into the same thread");
  store.close();
});

test("ingest is idempotent: re-ingesting the same message does not inflate thread counters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ing-idem-"));
  const store = Store.open(":memory:");
  const blobs = new BlobStore(join(dir, "blobs"));
  const deps = { store, blobs };

  const e1: EmlxEntry = { path: emlx(dir, "1.emlx", ROOT("idem@x")), account: "ACC", mailbox: "INBOX", isPartial: false, mtimeMs: 1 };

  await ingestEmlxFile(deps, e1);
  await ingestEmlxFile(deps, e1); // second ingest of the same message

  const msg = store.raw.prepare("SELECT thread_id FROM messages WHERE message_id=?").get("idem@x") as { thread_id: number } | undefined;
  assert.ok(msg != null, "message should exist exactly once");

  const thread = store.raw.prepare("SELECT msg_count FROM threads WHERE id=?").get(msg!.thread_id) as { msg_count: number };
  assert.equal(thread.msg_count, 1, "msg_count must be 1, not 2, after duplicate ingest");

  const rows = store.raw.prepare("SELECT COUNT(*) as cnt FROM messages WHERE message_id=?").get("idem@x") as { cnt: number };
  assert.equal(rows.cnt, 1, "message row count must be 1");

  store.close();
});
