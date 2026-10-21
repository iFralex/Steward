import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";
import { extractBody } from "../src/body.ts";

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    messageId: "m1@x",
    account: "ACC", mailbox: "INBOX",
    fromName: "Trenitalia", fromAddr: "noreply@trenitalia.it",
    to: ["me@x"], cc: [],
    subject: "Sconto -20% viaggi", date: 1750000000,
    bodyText: "Frecciarossa Roma Milano FRECCIA20",
    bodyState: "full", source: "emlx", emlxPath: "/p/1.emlx",
    inReplyTo: null, references: [], gmThrid: null, size: 100,
    toNames: [], ccNames: [], unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null,
    ...overrides,
  };
}

test("upsert dedups by messageId and FTS finds body terms", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  s.upsertMessage(row({ subject: "Sconto -20% viaggi (updated)" })); // same id -> update
  const hits = s.searchFts("frecciarossa", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "m1@x");
  assert.ok(hits[0].subject.includes("updated"));
  s.close();
});

test("body repair updates both search indexes without changing flags or identity", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row({bodyText:"Plain text version not available", unread:true, flagged:true}));
  assert.equal(s.updateBody("m1@x", "stale", "wrong"), false);
  assert.equal(s.updateBody("m1@x", "Plain text version not available", "Carica quietanza ENEA"), true);
  assert.equal(s.searchFts("quietanza", 10)[0]?.messageId, "m1@x");
  assert.equal(s.searchTrig("body_text", "quietanza", 10)[0]?.messageId, "m1@x");
  assert.equal(s.searchFts("available", 10).length, 0);
  assert.equal(s.getMessage("m1@x")?.flagged, true);
  assert.equal(s.getMessage("m1@x")?.unread, true);
  s.close();
});

test("extraction provenance round-trips; metadata-only upgrades do not invalidate embeddings", () => {
  const s = Store.open(":memory:");
  const result = extractBody("Ok", "<p>Ok</p>");
  s.upsertMessage(row({bodyText:result.text, bodyExtraction:result.extraction}));
  assert.deepEqual(s.getMessage("m1@x")?.bodyExtraction, result.extraction);
  s.raw.prepare("INSERT INTO embed_state(message_id,model,dim,source_hash,embedded_at) VALUES (?,?,?,?,?)")
    .run("m1@x", "test", 1, "hash", 2_000_000_000);
  const updated = s.raw.prepare("SELECT updated_at FROM messages WHERE message_id='m1@x'").get();
  assert.equal(s.updateBody("m1@x", result.text, result.text, {...result.extraction, reason:"metadata-upgrade"}), true);
  assert.deepEqual(s.raw.prepare("SELECT updated_at FROM messages WHERE message_id='m1@x'").get(), updated);
  assert.equal(s.getMessage("m1@x")?.bodyExtraction?.reason, "metadata-upgrade");
  assert.equal(s.messagesNeedingEmbedding(10).length, 0);
  assert.equal(s.updateBody("m1@x", result.text, "Nuova quietanza", result.extraction), true);
  assert.equal(s.messagesNeedingEmbedding(10)[0]?.messageId, "m1@x");
  s.close();
});

test("attachments and soft delete", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row());
  s.insertAttachments("m1@x", [{ filename: "p.pdf", mime: "application/pdf", size: 5, sha256: "abcd", relPath: "ab/abcd", downloaded: true }]);
  s.softDelete("m1@x");
  const got = s.getMessage("m1@x");
  assert.ok(got); // row remains (soft delete)
  const raw = s.raw.prepare("SELECT deleted FROM messages WHERE message_id=?").get("m1@x") as { deleted: number };
  assert.equal(raw.deleted, 1);
  s.close();
});

test("state get/set round-trips", () => {
  const s = Store.open(":memory:");
  s.setState("backfill.cursor", "42");
  assert.equal(s.getState("backfill.cursor"), "42");
  assert.equal(s.getState("missing"), undefined);
  s.close();
});

test("getMessageIdByPath: stored message found; unknown path returns undefined; soft-deleted row returns undefined", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row({ messageId: "path1@x", emlxPath: "/mail/1.emlx" }));
  // stored message is found by emlx_path
  assert.equal(s.getMessageIdByPath("/mail/1.emlx"), "path1@x");
  // unknown path returns undefined
  assert.equal(s.getMessageIdByPath("/mail/nope.emlx"), undefined);
  // soft-deleted row returns undefined
  s.softDelete("path1@x");
  assert.equal(s.getMessageIdByPath("/mail/1.emlx"), undefined);
  s.close();
});
