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
  assert.equal(item.sourceKey, "mail:m1");
  assert.equal(item.kind, "reply-needed");
  assert.equal(item.priority, "high");
  assert.equal(Array.isArray(item.payload.proposedActions), true);
  const proposed = item.payload.proposedActions as { steps: { input: { body: string } }[] }[];
  assert.equal(proposed[0].steps[0].input.body, "Ciao Anna, te lo mando domani.");
  mail.close();
  actions.close();
});

test("scanMailForActions keys actions by thread when available", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  mail.upsertMessage(row());
  mail.setThreadId("m1", 99);
  const res = await scanMailForActions({
    mail,
    actions,
    chat: async (system) => system.includes("Analyze")
      ? JSON.stringify({
          needsAction: true,
          kind: "reply-needed",
          priority: "normal",
          summary: "Thread action.",
          dueDateTime: null,
          scheduling: null,
          replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: "Ok." },
          reasoning: "Direct request.",
        })
      : JSON.stringify({
          title: "Thread action",
          summary: "Thread action.",
          proposedActions: [{
            id: "reply",
            label: "Reply",
            summary: "Send reply.",
            confidence: "high",
            steps: [{ id: "send", label: "Send", tool: "mcp__mail__reply", input: { messageId: "m1", body: "Ok." }, writes: true }],
          }],
        }),
  });
  assert.equal(res.created, 1);
  assert.equal(actions.list()[0].sourceKey, "mail:thread:99");
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

test("scanMailForActions updates an open action's summary when a same-domain reply on a DIFFERENT thread turns out to resolve it, without changing its status", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  const { id: openActionId } = actions.upsert({
    sourceKey: "mail:thread:37681",
    sourceKind: "mail",
    kind: "follow-up",
    title: "Follow-up sulla richiesta Credit Lombard",
    summary: "In attesa di risposta da Fineco.",
    payload: {
      threadId: 37681,
      contextSnapshot: { mail: { to: ["helpdesk@finecobank.com"], from: "Alessio <me@example.com>" } },
    },
  });
  actions.mark(openActionId, "read");

  mail.upsertMessage(row({
    messageId: "fineco-reply-1",
    fromName: "",
    fromAddr: "helpdesk@finecobank.com",
    to: ["me@example.com"],
    subject: "[FIN80822562] Comunicazione da FinecoBank",
    bodyText: "La valutazione avviene entro circa 10 giorni lavorativi.",
  }));
  mail.setThreadId("fineco-reply-1", 37682); // a DIFFERENT thread than the open action's 37681

  const res = await scanMailForActions({
    mail,
    actions,
    userAddrs: ["me@example.com"],
    chat: async (system) => {
      if (system.includes("Analyze")) {
        return JSON.stringify({
          needsAction: false,
          kind: "admin-task",
          priority: "normal",
          summary: "No action.",
          dueDateTime: null,
          scheduling: null,
          replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: null },
          reasoning: "Just an informational reply.",
        });
      }
      if (system.includes("resolves or updates")) {
        return JSON.stringify({
          resolves: true,
          updatedSummary: "Fineco ha risposto: la valutazione avviene entro ~10 giorni lavorativi.",
        });
      }
      return JSON.stringify({ proposedActions: [] });
    },
  });

  assert.equal(res.deferred, 1);
  assert.equal(actions.list().length, 1, "no new action created for the reply itself — only the original open action remains");
  const updated = actions.get(openActionId)!;
  assert.equal(updated.summary, "Fineco ha risposto: la valutazione avviene entro ~10 giorni lavorativi.");
  assert.equal(updated.status, "read", "must stay open for manual confirmation, not auto-close");
  mail.close();
  actions.close();
});

test("scanMailForActions skips low-value surveys without calling LLM", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  mail.upsertMessage(row({
    fromAddr: "feedback@example.com",
    subject: "IELTS Post Result Survey",
    bodyText: "Please fill the survey. Do not reply.",
  }));
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

test("scanMailForActions can include read mail for rebuilds", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  mail.upsertMessage(row({ unread: false }));
  let called = false;
  const res = await scanMailForActions({
    mail,
    actions,
    chat: async (system) => {
      called = true;
      if (system.includes("Analyze")) {
        return JSON.stringify({
          needsAction: false,
          kind: "admin-task",
          priority: "normal",
          summary: "No action.",
          dueDateTime: null,
          scheduling: null,
          replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: null },
          reasoning: "test",
        });
      }
      return JSON.stringify({ proposedActions: [] });
    },
  });
  assert.equal(called, true);
  assert.equal(res.considered, 1);
  mail.close();
  actions.close();
});

test("scanMailForActions can target a single thread", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  mail.upsertMessage(row({ messageId: "m1" }));
  mail.upsertMessage(row({ messageId: "m2" }));
  mail.setThreadId("m1", 10);
  mail.setThreadId("m2", 20);
  const seen: string[] = [];
  const res = await scanMailForActions({
    mail,
    actions,
    threadId: 20,
    chat: async (system, prompt) => {
      if (system.includes("Analyze")) {
        seen.push(prompt);
        return JSON.stringify({
          needsAction: false,
          kind: "admin-task",
          priority: "normal",
          summary: "No action.",
          dueDateTime: null,
          scheduling: null,
          replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: null },
          reasoning: "test",
        });
      }
      return JSON.stringify({ proposedActions: [] });
    },
  });
  assert.equal(res.considered, 1);
  assert.match(seen[0], /m2|Mi mandi il documento/);
  mail.close();
  actions.close();
});

test("scanMailForActions plans once per thread using aggregated thread context", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  const now = Math.floor(Date.now() / 1000);
  mail.upsertMessage(row({
    messageId: "giulia-1",
    fromName: "Giulia",
    fromAddr: "giulia@example.com",
    to: ["me@example.com"],
    subject: "Presenze GIUGNO 2026",
    date: now - 200,
    bodyText: "Vi chiedo di comunicare le presenze di giugno.",
  }));
  mail.upsertMessage(row({
    messageId: "giulia-2",
    fromName: "Giulia",
    fromAddr: "giulia@example.com",
    to: ["me@example.com"],
    subject: "R: Presenze GIUGNO 2026",
    date: now - 100,
    bodyText: "Vi ricordo che dovete comunicare come scaricare il ponte del 1 giugno.",
  }));
  mail.upsertMessage(row({
    messageId: "colleague-1",
    fromName: "Collega",
    fromAddr: "colleague@example.com",
    to: ["giulia@example.com"],
    subject: "RE: Presenze GIUGNO 2026",
    date: now - 10,
    bodyText: "Per me il 1 giugno è ROL.\n\nFrom: Giulia\nVi ricordo che dovete comunicare come scaricare il ponte del 1 giugno.",
  }));
  for (const id of ["giulia-1", "giulia-2", "colleague-1"]) mail.setThreadId(id, 77);
  let analyzeCalls = 0;
  const prompts: string[] = [];
  const res = await scanMailForActions({
    mail,
    actions,
    userAddrs: ["me@example.com"],
    chat: async (system, prompt) => {
      if (system.includes("Analyze")) {
        analyzeCalls++;
        prompts.push(prompt);
        return JSON.stringify({
          needsAction: true,
          kind: "admin-task",
          priority: "normal",
          summary: "Serve rispondere a Giulia.",
          dueDateTime: null,
          scheduling: null,
          replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: "Ok." },
          reasoning: "Thread request.",
        });
      }
      return JSON.stringify({
        title: "Rispondi a Giulia",
        summary: "Thread action.",
        proposedActions: [{
          id: "reply",
          label: "Reply",
          summary: "Send reply.",
          confidence: "high",
          steps: [{ id: "send", label: "Send", tool: "mcp__mail__reply", input: { messageId: "giulia-2", body: "Ok." }, writes: true }],
        }],
      });
    },
    now,
  });

  assert.equal(res.considered, 1);
  assert.equal(analyzeCalls, 1);
  assert.match(prompts[0], /THREAD CONTEXT/);
  assert.match(prompts[0], /comunicare le presenze/);
  assert.match(prompts[0], /scaricare il ponte/);
  assert.match(prompts[0], /Per me il 1 giugno è ROL/);
  const item = actions.list()[0];
  assert.equal(item.sourceKey, "mail:thread:77");
  assert.equal(item.payload.triggerMessageId, "colleague-1");
  assert.equal(item.payload.messageId, "giulia-2");
  mail.close();
  actions.close();
});

const noActionChat = async (system: string) =>
  system.includes("Analyze")
    ? JSON.stringify({ needsAction: false, kind: "admin-task", priority: "normal", summary: "x", dueDateTime: null, scheduling: null, replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: null }, reasoning: "x" })
    : JSON.stringify({ proposedActions: [] });

test("does not re-evaluate already-seen mail on the next scan", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  mail.upsertMessage(row());
  mail.setThreadId("m1", 1);
  let analyzeCalls = 0;
  const chat = async (system: string, prompt: string) => { if (system.includes("Analyze")) analyzeCalls++; return noActionChat(system); };

  const r1 = await scanMailForActions({ mail, actions, chat });
  assert.equal(r1.considered, 1);
  assert.equal(analyzeCalls, 1);

  const r2 = await scanMailForActions({ mail, actions, chat });
  assert.equal(r2.considered, 0); // already seen → not reconsidered
  assert.equal(analyzeCalls, 1); // planner not called again
  mail.close();
  actions.close();
});

test("markSeen is incremental: a candidate processed before a mid-scan failure stays marked seen", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  const now = Math.floor(Date.now() / 1000);
  // Two independent threads/candidates. Candidates are processed in descending
  // trigger-date order, so "keep-1" (newer) is handled before "boom-1" (older).
  mail.upsertMessage(row({ messageId: "keep-1", subject: "Keep This", date: now, fromAddr: "a@example.com" }));
  mail.setThreadId("keep-1", 501);
  mail.upsertMessage(row({ messageId: "boom-1", subject: "Boom This", date: now - 100, fromAddr: "b@example.com" }));
  mail.setThreadId("boom-1", 502);

  const chat = async (system: string, prompt: string) => {
    if (system.includes("Analyze")) {
      if (prompt.includes("Boom This")) throw new Error("planner exploded");
      return JSON.stringify({
        needsAction: true,
        kind: "reply-needed",
        priority: "normal",
        summary: "Keep this thread.",
        dueDateTime: null,
        scheduling: null,
        replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: "Ok." },
        reasoning: "test",
      });
    }
    return JSON.stringify({
      title: "Reply",
      summary: "Reply.",
      proposedActions: [{
        id: "reply",
        label: "Reply",
        summary: "Send reply.",
        confidence: "high",
        steps: [{ id: "send", label: "Send", tool: "mcp__mail__reply", input: { messageId: "keep-1", body: "Ok." }, writes: true }],
      }],
    });
  };

  const res = await scanMailForActions({ mail, actions, chat, now });
  assert.equal(res.considered, 2);
  assert.equal(res.created, 1);
  assert.equal(res.deferred, 1);

  const seen = actions.loadSeen();
  assert.equal(seen.has("keep-1"), true, "candidate processed before the failure must stay marked seen");
  assert.equal(seen.has("boom-1"), false, "candidate whose planning threw must not be marked seen (so it's retried)");
  mail.close();
  actions.close();
});

test("seedIfEmpty marks the current window seen without evaluating; new mail is then picked up", async () => {
  const mail = Store.open(":memory:");
  const actions = ActionStore.open(":memory:");
  mail.upsertMessage(row({ messageId: "old" }));
  mail.setThreadId("old", 1);
  let analyzeCalls = 0;
  const chat = async (system: string, prompt: string) => { if (system.includes("Analyze")) analyzeCalls++; return noActionChat(system); };

  const seed = await scanMailForActions({ mail, actions, chat, seedIfEmpty: true });
  assert.equal(seed.considered, 0);
  assert.ok((seed.seeded ?? 0) >= 1);
  assert.equal(analyzeCalls, 0); // clean start evaluates nothing

  mail.upsertMessage(row({ messageId: "new", date: Math.floor(Date.now() / 1000) }));
  mail.setThreadId("new", 2);
  const res = await scanMailForActions({ mail, actions, chat, seedIfEmpty: true });
  assert.equal(res.considered, 1); // only the new one
  assert.equal(analyzeCalls, 1);
  mail.close();
  actions.close();
});
