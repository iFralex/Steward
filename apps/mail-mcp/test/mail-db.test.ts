import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { Mail } from "../src/mail.ts";

function row(id: string, subject: string, body: string): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "T", fromAddr: "noreply@trenitalia.it",
    to: ["me@x"], cc: [], subject, date: 1750000000, bodyText: body, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

test("Mail.search uses the DB (FTS body match)", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a@x", "Sconto", "Frecciarossa Roma Milano"));
  const mail = new Mail({ store: s });
  const hits = await mail.search({ query: "frecciarossa" } as any);
  assert.equal(hits[0].messageId, "a@x");
  s.close();
});

test("Mail.read uses the DB body", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a@x", "Sconto", "BODY HERE"));
  const mail = new Mail({ store: s });
  const d = await mail.read({ messageId: "a@x" } as any);
  assert.ok(d.body.includes("BODY HERE"));
  s.close();
});
