// apps/mail-promoter/test/run.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../mail-mirror/src/store.ts";
import { PromoteState } from "../src/state.ts";
import { processThread, runBatch, type RunDeps } from "../src/run.ts";

function row(over = {}) {
  return {
    messageId: "m1", account: "ACC", mailbox: "INBOX", fromName: "Anna", fromAddr: "anna@x.com",
    to: [], cc: [], toNames: [], ccNames: [], subject: "Certificati", date: 1750000000,
    bodyText: "Mi servono i certificati entro venerdì.", bodyState: "full" as const, source: "emlx" as const,
    emlxPath: null, inReplyTo: null, references: [], gmThrid: null, size: 1, unread: false, flagged: false,
    answered: false, junk: false, flagColor: null, appleThrid: null, ...over,
  };
}

function deps(over: Partial<RunDeps> = {}): RunDeps {
  const store = Store.open(":memory:");
  store.upsertMessage(row());
  store.setThreadId("m1", 1);
  return {
    store, state: PromoteState.open(":memory:"),
    chat: async () => '{"promote": true, "categories": ["commitment"], "note": {"summary":"s","facts":[],"commitments":["inviare"],"people":["Anna"],"orgs":[]}}',
    wiki: { addSources: async () => ({}) },
    roleOf: () => "inbox", accountLabelOf: () => "biz@x.com", ...over,
  };
}

test("processThread promotes a durable thread and records state keyed by thread", async () => {
  const d = deps();
  const r = await processThread(d, 1);
  assert.equal(r, "promoted");
  assert.equal(d.state.get("thread:1")?.decision, "promoted");
});

test("processThread collapses a multi-message thread into ONE triage call + one note", async () => {
  const d = deps();
  d.store.upsertMessage(row({ messageId: "m1b", subject: "Re: Certificati", date: 1750000100, bodyText: "Ecco i certificati." }));
  d.store.setThreadId("m1b", 1);
  let calls = 0;
  const promoted: unknown[] = [];
  const d2: RunDeps = { ...d, chat: async () => { calls++; return '{"promote": true, "categories": [], "note": {"summary":"s","facts":[],"commitments":[],"people":[],"orgs":[]}}'; }, wiki: { addSources: async (_p, s) => { promoted.push(s); return {}; } } };
  const r = await processThread(d2, 1);
  assert.equal(r, "promoted");
  assert.equal(calls, 1, "one triage call for the whole thread");
  assert.equal(promoted.length, 1, "one note for the whole thread");
});

test("processThread filters a junk-role thread without calling the LLM", async () => {
  let called = false;
  const d = deps({ roleOf: () => "junk", chat: async () => { called = true; return "{}"; } });
  const r = await processThread(d, 1);
  assert.equal(r, "filtered");
  assert.equal(called, false);
  assert.equal(d.state.get("thread:1")?.decision, "filtered");
});

test("a previously-filtered thread is skipped on re-run (no re-evaluation)", async () => {
  const d = deps({ roleOf: () => "junk" });
  assert.equal(await processThread(d, 1), "filtered");
  assert.equal(await processThread(d, 1), "skipped");
});

test("processThread defers (no state) when the classifier is unavailable", async () => {
  const d = deps({ chat: async () => { throw new Error("down"); } });
  const r = await processThread(d, 1);
  assert.equal(r, "deferred");
  assert.equal(d.state.get("thread:1"), undefined);
});

test("runBatch processes every thread with concurrency > 1", async () => {
  const d = deps();
  for (let i = 2; i <= 20; i++) { d.store.upsertMessage(row({ messageId: `m${i}` })); d.store.setThreadId(`m${i}`, i); }
  let inFlight = 0, maxInFlight = 0;
  const d2: RunDeps = {
    ...d,
    chat: async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return '{"promote": false, "categories": [], "note": null}';
    },
  };
  const tally = await runBatch(d2, { concurrency: 5 });
  assert.equal(tally.promoted + tally.skipped + tally.filtered + tally.deferred, 20);
  assert.equal(tally.skipped, 20);
  assert.ok(maxInFlight > 1, `expected concurrent calls, saw max ${maxInFlight}`);
  assert.ok(maxInFlight <= 5, `concurrency cap exceeded: ${maxInFlight}`);
});
