import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { ActionStore } from "../src/store.ts";
import { scanMailForActions } from "../src/mail.ts";

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    messageId: "m1",
    account: "ACC",
    mailbox: "INBOX",
    fromName: "Anna",
    fromAddr: "anna@example.com",
    to: ["me@example.com"],
    cc: [],
    toNames: [],
    ccNames: [],
    subject: "Mi mandi il documento?",
    date: Math.floor(Date.now() / 1000),
    bodyText: "Ciao, puoi mandarmi il documento entro domani?",
    bodyState: "full",
    source: "emlx",
    emlxPath: null,
    inReplyTo: null,
    references: [],
    gmThrid: null,
    size: 1,
    unread: true,
    flagged: false,
    answered: false,
    junk: false,
    flagColor: null,
    appleThrid: null,
    ...overrides,
  };
}

test("scanMailForActions creates reply-needed action with draft", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  mail.upsertMessage(row());
  const res = await scanMailForActions({
    mail,
    actions,
    chat: async (system) => system.includes("Analyze")
      ? JSON.stringify({
          needsAction: true,
          kind: "reply-needed",
          priority: "high",
          summary: "Anna chiede il documento.",
          dueDateTime: "2026-06-27T09:00:00.000Z",
          scheduling: null,
          replyDrafts: {
            accept: null,
            decline: null,
            proposeAlternative: null,
            askClarification: "Ciao Anna, te lo mando domani.",
          },
          reasoning: "Direct request.",
        })
      : JSON.stringify({
          title: "Reply to Anna",
          summary: "Anna chiede il documento.",
          proposedActions: [{
            id: "reply",
            label: "Reply",
            summary: "Send the prepared reply.",
            confidence: "high",
            steps: [{
              id: "send-reply",
              label: "Send reply",
              tool: "mcp__mail__reply",
              input: { messageId: "m1", body: "Ciao Anna, te lo mando domani.", replyAll: true },
              writes: true,
            }],
          }],
        }),
    now: Math.floor(Date.now() / 1000),
  });
  assert.equal(res.created, 1);
  const item = actions.list()[0];
  assert.equal(item.kind, "reply-needed");
  assert.equal(item.priority, "high");
  assert.equal(Array.isArray(item.payload.proposedActions), true);
  const proposed = item.payload.proposedActions as { steps: { input: { body: string } }[] }[];
  assert.equal(proposed[0].steps[0].input.body, "Ciao Anna, te lo mando domani.");
  mail.close();
  actions.close();
});

test("scanMailForActions skips no-reply senders without calling LLM", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  mail.upsertMessage(row({ fromAddr: "no-reply@example.com" }));
  let called = false;
  const res = await scanMailForActions({
    mail,
    actions,
    chat: async () => {
      called = true;
      return "{}";
    },
  });
  assert.equal(called, false);
  assert.equal(res.skipped, 1);
  assert.equal(actions.list().length, 0);
  mail.close();
  actions.close();
});
