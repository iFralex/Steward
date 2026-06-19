// apps/mail-mcp/test/db-thread.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { getThread } from "../src/db-thread.ts";

function row(id: string, date: number): MessageRow {
  return {
    messageId: id, account: "A", mailbox: "INBOX", fromName: "T", fromAddr: "a@b",
    to: ["x@y"], cc: [], toNames: [], ccNames: [], subject: "S", date, bodyText: "b",
    bodyState: "full", source: "emlx", emlxPath: null, inReplyTo: null, references: [],
    gmThrid: null, size: 1, unread: false, flagged: false, answered: false, junk: false,
    flagColor: null, appleThrid: null,
  };
}

test("getThread returns all messages in a thread, ordered by date asc", () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("m1", 200));
  s.upsertMessage(row("m2", 100));
  s.setThreadId("m1", 7);
  s.setThreadId("m2", 7);
  const out = getThread(s, { messageId: "m1" });
  assert.deepEqual(out.map((m) => m.messageId), ["m2", "m1"]);
  s.close();
});

test("getThread throws when the thread cannot be resolved", () => {
  const s = Store.open(":memory:");
  assert.throws(() => getThread(s, { messageId: "nope" }), /thread/i);
  s.close();
});
