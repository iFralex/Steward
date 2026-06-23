// apps/mail-promoter/test/triage.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { triage } from "../src/triage.ts";

const msg = { fromName: "Anna", fromAddr: "anna@x.com", subject: "Certificati", bodyText: "Mi servono i certificati entro venerdì." };

test("triage parses a fenced combined verdict with a note", async () => {
  const chat = async () =>
    '```json\n{"promote": true, "categories": ["commitment", "document"], "note": {"summary":"Anna chiede certificati","facts":["entro venerdì"],"commitments":["inviare certificati"],"people":["Anna"],"orgs":[]}}\n```';
  const r = await triage(msg, chat);
  assert.equal(r?.promote, true);
  assert.deepEqual(r?.categories, ["commitment", "document"]);
  assert.equal(r?.note?.summary, "Anna chiede certificati");
  assert.deepEqual(r?.note?.commitments, ["inviare certificati"]);
});

test("triage returns a skip verdict with a null note (no second call needed)", async () => {
  const chat = async () => '{"promote": false, "categories": [], "note": null}';
  const r = await triage(msg, chat);
  assert.deepEqual(r, { promote: false, categories: [], note: null });
});

test("triage drops out-of-allowlist categories", async () => {
  const chat = async () =>
    '{"promote": true, "categories": ["commitment", "spam", "urgent", "document"], "note": {"summary":"s","facts":[],"commitments":[],"people":[],"orgs":[]}}';
  const r = await triage(msg, chat);
  assert.deepEqual(r?.categories, ["commitment", "document"]);
});

test("triage defers (null) when it promotes without a usable note", async () => {
  const chat = async () => '{"promote": true, "categories": ["commitment"], "note": null}';
  assert.equal(await triage(msg, chat), null);
});

test("triage returns null when the model errors", async () => {
  const chat = async () => { throw new Error("gateway down"); };
  assert.equal(await triage(msg, chat), null);
});

test("triage returns null on unparseable output", async () => {
  const chat = async () => "I cannot answer that.";
  assert.equal(await triage(msg, chat), null);
});
