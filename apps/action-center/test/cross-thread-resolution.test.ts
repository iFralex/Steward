import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionStore } from "../src/store.ts";
import { checkIfMessageResolvesAction, findResolvableOpenActions, selectContinuationCandidates } from "../src/cross-thread-resolution.ts";
import type { ActionItem } from "../src/types.ts";

const openAction = { title: "Follow-up sulla richiesta Credit Lombard", summary: "In attesa di risposta da Fineco." };
const reply = {
  subject: "[FIN80822562] Comunicazione da FinecoBank",
  fromName: "",
  fromAddr: "helpdesk@finecobank.com",
  bodyText: "La valutazione avviene entro circa 10 giorni lavorativi. Riceverà l'esito via mail.",
};

function openMailAction(store: ActionStore, overrides: { sourceKey: string; threadId: number; to?: string[]; from?: string }): void {
  store.upsert({
    sourceKey: overrides.sourceKey,
    sourceKind: "mail",
    kind: "follow-up",
    title: "t",
    summary: "s",
    payload: {
      threadId: overrides.threadId,
      contextSnapshot: {
        mail: {
          to: overrides.to ?? ["helpdesk@finecobank.com"],
          from: overrides.from ?? "Alessio Antonucci <me@example.com>",
        },
      },
    },
  });
}

test("findResolvableOpenActions matches an open mail action by sender domain, even on a different thread", () => {
  const store = ActionStore.open(":memory:");
  openMailAction(store, { sourceKey: "mail:thread:37681", threadId: 37681, to: ["helpdesk@finecobank.com"] });
  const matches = findResolvableOpenActions(
    store.list({ includeDone: false }),
    { fromAddr: "helpdesk@finecobank.com", threadId: 37682 },
    ["me@example.com"],
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sourceKey, "mail:thread:37681");
  store.close();
});

test("findResolvableOpenActions excludes actions whose domain does not match", () => {
  const store = ActionStore.open(":memory:");
  openMailAction(store, { sourceKey: "mail:thread:1", threadId: 1, to: ["someone@other.example"] });
  const matches = findResolvableOpenActions(
    store.list({ includeDone: false }),
    { fromAddr: "helpdesk@finecobank.com", threadId: 2 },
    ["me@example.com"],
  );
  assert.equal(matches.length, 0);
  store.close();
});

test("findResolvableOpenActions excludes the action already on the same thread as the new message", () => {
  const store = ActionStore.open(":memory:");
  openMailAction(store, { sourceKey: "mail:thread:37682", threadId: 37682, to: ["helpdesk@finecobank.com"] });
  const matches = findResolvableOpenActions(
    store.list({ includeDone: false }),
    { fromAddr: "helpdesk@finecobank.com", threadId: 37682 },
    ["me@example.com"],
  );
  assert.equal(matches.length, 0, "same-thread continuations are already handled by the normal upsert path");
  store.close();
});

test("findResolvableOpenActions never matches the user's own domain", () => {
  const store = ActionStore.open(":memory:");
  openMailAction(store, { sourceKey: "mail:thread:1", threadId: 1, to: ["me@example.com"] });
  const matches = findResolvableOpenActions(
    store.list({ includeDone: false }),
    { fromAddr: "me@example.com", threadId: 2 },
    ["me@example.com"],
  );
  assert.equal(matches.length, 0);
  store.close();
});

test("findResolvableOpenActions caps to the 5 most recently updated matches", () => {
  const now = 1_800_000_000;
  const actions: ActionItem[] = Array.from({ length: 7 }, (_, i) => ({
    id: i + 1,
    sourceKey: `mail:thread:${i}`,
    sourceKind: "mail",
    kind: "follow-up",
    status: "read",
    priority: "normal",
    title: "t",
    summary: "s",
    dueAt: null,
    createdAt: now,
    updatedAt: now + i, // action 6 (index 6) is the most recently updated
    payload: { threadId: 100 + i, contextSnapshot: { mail: { to: ["helpdesk@finecobank.com"], from: "me@example.com" } } },
  }));
  const matches = findResolvableOpenActions(actions, { fromAddr: "helpdesk@finecobank.com", threadId: 999 }, ["me@example.com"]);
  assert.equal(matches.length, 5);
  assert.deepEqual(matches.map((m) => m.id), [7, 6, 5, 4, 3]);
});

test("selectContinuationCandidates keeps only the matching account identifier and a compact summary", () => {
  const now = 1_800_000_000;
  const make = (id: number, last4: string, summary: string): ActionItem => ({
    id,
    sourceKey: `mail:thread:${id}`,
    sourceKind: "mail",
    kind: "admin-task",
    status: "new",
    priority: "high",
    title: `Carta Fineco ****${last4} bloccata`,
    summary,
    dueAt: null,
    createdAt: now,
    updatedAt: now + id,
    payload: { threadId: id, contextSnapshot: { mail: { from: "Fineco <service@finecobank.com>" } } },
  });
  const candidates = selectContinuationCandidates(
    [make(1, "5675", "s".repeat(900)), make(2, "9911", "Altra carta bloccata")],
    { fromAddr: "service@finecobank.com", threadId: 3, subject: "Nuovo blocco carta ****5675", bodyText: "Verificare la carta ****5675." },
    ["me@example.com"],
  );
  assert.deepEqual(candidates.map((candidate) => candidate.id), [1]);
  assert.equal(candidates[0].summary.length, 500);
  assert.equal("sourceKey" in candidates[0], false);
});

test("selectContinuationCandidates rejects a different repository when both alerts have strong repo anchors", () => {
  const action: ActionItem = {
    id: 1,
    sourceKey: "mail:thread:1",
    sourceKind: "mail",
    kind: "admin-task",
    status: "new",
    priority: "high",
    title: "GitGuardian secret in owner/first-repo",
    summary: "Rotate the leaked password and resolve the incident.",
    dueAt: null,
    createdAt: 1,
    updatedAt: 1,
    payload: { threadId: 1, contextSnapshot: { mail: { from: "GitGuardian <alerts@gitguardian.com>" } } },
  };
  const candidates = selectContinuationCandidates(
    [action],
    { fromAddr: "alerts@gitguardian.com", threadId: 2, subject: "Secret in owner/second-repo", bodyText: "A password was detected in owner/second-repo." },
    ["me@example.com"],
  );
  assert.deepEqual(candidates, []);
});

test("selectContinuationCandidates does not link unrelated notifications just because sender and brand match", () => {
  const action: ActionItem = {
    id: 1,
    sourceKey: "mail:thread:1",
    sourceKind: "mail",
    kind: "admin-task",
    status: "new",
    priority: "normal",
    title: "Accetta l'invito LinkedIn di Giorgio",
    summary: "Valuta il profilo di Giorgio e decidi se accettare il collegamento.",
    dueAt: null,
    createdAt: 1,
    updatedAt: 1,
    payload: { threadId: 1, contextSnapshot: { mail: { from: "LinkedIn <messages-noreply@linkedin.com>" } } },
  };
  const candidates = selectContinuationCandidates(
    [action],
    { fromAddr: "messages-noreply@linkedin.com", threadId: 2, subject: "XiangYu ti ha invitato a collegarti", bodyText: "Visualizza il profilo di XiangYu oppure accetta il suo invito." },
    ["me@example.com"],
  );
  assert.deepEqual(candidates, []);
});

test("selectContinuationCandidates retains a prose match only when several specific terms agree", () => {
  const action: ActionItem = {
    id: 1,
    sourceKey: "mail:thread:1",
    sourceKind: "mail",
    kind: "admin-task",
    status: "new",
    priority: "normal",
    title: "Completa la formazione cybersecurity obbligatoria",
    summary: "Il corso cybersecurity annuale richiede il completamento del quiz finale.",
    dueAt: null,
    createdAt: 1,
    updatedAt: 1,
    payload: { threadId: 1, contextSnapshot: { mail: { from: "Training <training@example.org>" } } },
  };
  const candidates = selectContinuationCandidates(
    [action],
    { fromAddr: "reminders@example.org", threadId: 2, subject: "Promemoria formazione cybersecurity", bodyText: "Completa il corso cybersecurity e il quiz finale." },
    ["me@example.com"],
  );
  assert.deepEqual(candidates.map((candidate) => candidate.id), [1]);
});

test("checkIfMessageResolvesAction returns the updated summary when the LLM says the message resolves the task", async () => {
  const result = await checkIfMessageResolvesAction(openAction, reply, async () => JSON.stringify({
    resolves: true,
    updatedSummary: "Fineco ha risposto: la valutazione avviene entro ~10 giorni lavorativi.",
  }));
  assert.equal(result.resolves, true);
  assert.equal(result.updatedSummary, "Fineco ha risposto: la valutazione avviene entro ~10 giorni lavorativi.");
});

test("checkIfMessageResolvesAction returns resolves:false when the LLM says the message is unrelated", async () => {
  const result = await checkIfMessageResolvesAction(openAction, reply, async () => JSON.stringify({
    resolves: false,
    updatedSummary: null,
  }));
  assert.equal(result.resolves, false);
  assert.equal(result.updatedSummary, undefined);
});

test("checkIfMessageResolvesAction fails safe (resolves:false) on an unparseable LLM response", async () => {
  const result = await checkIfMessageResolvesAction(openAction, reply, async () => "not json");
  assert.equal(result.resolves, false);
});

test("checkIfMessageResolvesAction fails safe when the LLM says resolves:true but omits a summary", async () => {
  const result = await checkIfMessageResolvesAction(openAction, reply, async () => JSON.stringify({ resolves: true }));
  assert.equal(result.resolves, false, "a resolution without a usable updated summary must not be applied");
});
