import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { Mail } from "../src/mail.ts";

function row(id: string, subject: string, body: string, date = 1750000000): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "T", fromAddr: "noreply@trenitalia.it",
    to: ["me@x"], cc: [], subject, date, bodyText: body, bodyState: "full",
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

// Fix 1: dateFrom/dateTo ISO strings are properly converted to epoch-second numbers
// so the SQL date filter actually fires.
test("Mail.search: dateFrom/dateTo ISO strings filter messages correctly", async () => {
  const s = Store.open(":memory:");
  // Use Date.parse to get correct epoch seconds to avoid hard-coded values drifting.
  const inRange = Math.floor(Date.parse("2026-06-01") / 1000);    // exactly on the start boundary
  const beforeRange = Math.floor(Date.parse("2026-05-31") / 1000); // one day before
  s.upsertMessage(row("in@x", "In range", "body in", inRange));
  s.upsertMessage(row("out@x", "Out of range", "body out", beforeRange));
  const mail = new Mail({ store: s });
  const hits = await mail.search({
    dateFrom: "2026-06-01",
    dateTo: "2026-12-31",
  });
  assert.ok(hits.find((h) => h.messageId === "in@x"), "in-range message should appear");
  assert.ok(!hits.find((h) => h.messageId === "out@x"), "out-of-range message should be excluded");
  s.close();
});
