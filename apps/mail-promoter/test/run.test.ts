// apps/mail-promoter/test/run.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../mail-mirror/src/store.ts";
import { PromoteState } from "../src/state.ts";
import { processOne, runBatch, type RunDeps } from "../src/run.ts";

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
  return {
    store, state: PromoteState.open(":memory:"),
    chat: async () => '{"promote": true, "categories": ["commitment"], "note": {"summary":"s","facts":[],"commitments":["inviare"],"people":["Anna"],"orgs":[]}}',
    wiki: { addSources: async () => ({}) },
    roleOf: () => "inbox", accountLabelOf: () => "biz@x.com", ...over,
  };
}

test("processOne promotes a durable mail and records state", async () => {
  const d = deps();
  const r = await processOne(d, d.store.getMessage("m1")!);
  assert.equal(r, "promoted");
  assert.equal(d.state.get("m1")?.decision, "promoted");
});

test("processOne filters a junk-role mail without calling the LLM", async () => {
  let called = false;
  const d = deps({ roleOf: () => "junk", chat: async () => { called = true; return "{}"; } });
  const r = await processOne(d, d.store.getMessage("m1")!);
  assert.equal(r, "filtered");
  assert.equal(called, false);
  assert.equal(d.state.get("m1")?.decision, "filtered");
});

test("a previously-filtered mail is skipped on re-run (no re-evaluation)", async () => {
  const d = deps({ roleOf: () => "junk" });
  const m = d.store.getMessage("m1")!;
  assert.equal(await processOne(d, m), "filtered");
  assert.equal(await processOne(d, m), "skipped");
});

test("processOne defers (no state) when the classifier is unavailable", async () => {
  const d = deps({ chat: async () => { throw new Error("down"); } });
  const r = await processOne(d, d.store.getMessage("m1")!);
  assert.equal(r, "deferred");
  assert.equal(d.state.get("m1"), undefined);
});

test("runBatch processes every message with concurrency > 1", async () => {
  const d = deps();
  for (let i = 2; i <= 20; i++) d.store.upsertMessage(row({ messageId: `m${i}` }));
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
