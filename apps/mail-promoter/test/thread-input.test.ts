// apps/mail-promoter/test/thread-input.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../mail-mirror/src/store.ts";
import { buildThreadInput } from "../src/thread-input.ts";

function row(over = {}) {
  return {
    messageId: "m1", account: "ACC", mailbox: "INBOX", fromName: "Anna", fromAddr: "anna@x.com",
    to: ["me@x.com"], cc: [], toNames: [], ccNames: [], subject: "Certificati", date: 1750000000,
    bodyText: "Mi servono i certificati.", bodyState: "full" as const, source: "emlx" as const,
    emlxPath: null, inReplyTo: null, references: [], gmThrid: null, size: 1, unread: false, flagged: false,
    answered: false, junk: false, flagColor: null, appleThrid: null, ...over,
  };
}

test("buildThreadInput renders messages chronologically with aggregated recipients", () => {
  const store = Store.open(":memory:");
  store.upsertMessage(row({ messageId: "a", date: 200, fromName: "Anna", bodyText: "Domanda iniziale." }));
  store.upsertMessage(row({ messageId: "b", date: 100, fromName: "Bob", fromAddr: "bob@x.com", to: ["anna@x.com"], subject: "Re: Certificati", bodyText: "Risposta di Bob." }));
  store.setThreadId("a", 7);
  store.setThreadId("b", 7);

  const t = buildThreadInput(store, 7)!;
  assert.equal(t.threadId, 7);
  assert.equal(t.messages.length, 2);
  assert.equal(t.primary.messageId, "a", "primary is the most recent (date 200)");
  assert.equal(t.subject, "Re: Certificati", "subject from the chronological initiator (date 100)");
  assert.deepEqual(t.messageIds, ["b", "a"]);
  // transcript is chronological: Bob (100) before Anna (200)
  assert.ok(t.bodyText.indexOf("Risposta di Bob") < t.bodyText.indexOf("Domanda iniziale"));
  assert.ok(t.to.includes("me@x.com") && t.to.includes("anna@x.com"), "recipients aggregated across the thread");
});

test("buildThreadInput returns null for an empty thread", () => {
  const store = Store.open(":memory:");
  assert.equal(buildThreadInput(store, 999), null);
});
