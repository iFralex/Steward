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
  assert.equal(r?.promoteMail, true);
  assert.deepEqual(r?.categories, ["commitment", "document"]);
  assert.equal(r?.note?.summary, "Anna chiede certificati");
  assert.deepEqual(r?.note?.commitments, ["inviare certificati"]);
  assert.deepEqual(r?.attachments, []);
});

test("triage returns a skip verdict with a null note (no second call needed)", async () => {
  const chat = async () => '{"promote": false, "categories": [], "note": null}';
  const r = await triage(msg, chat);
  assert.deepEqual(r, { promote: false, promoteMail: false, categories: [], note: null, attachments: [] });
});

test("triage parses a valid reviewBy and nulls a malformed one", async () => {
  const ok = async () => '{"promote":true,"categories":[],"note":{"summary":"s","facts":[],"commitments":[],"people":[],"orgs":[],"reviewBy":"2026-08-15"}}';
  assert.equal((await triage(msg, ok))?.note?.reviewBy, "2026-08-15");
  const bad = async () => '{"promote":true,"categories":[],"note":{"summary":"s","facts":[],"commitments":[],"people":[],"orgs":[],"reviewBy":"someday"}}';
  assert.equal((await triage(msg, bad))?.note?.reviewBy, null);
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

test("triage can promote selected attachments without promoting the mail note", async () => {
  const chat = async () =>
    '{"promoteMail":false,"categories":[],"note":null,"attachments":[{"id":"att-1","promote":true,"reason":"CV durable","categories":["cv","spam"]},{"id":"missing","promote":true,"reason":"ignored","categories":["document"]}]}';
  const r = await triage(msg, chat, {
    attachments: [
      { id: "att-1", filename: "CV.pdf", mime: "application/pdf", size: 1000, messageId: "m1" },
      { id: "att-2", filename: "logo.png", mime: "image/png", size: 1000, messageId: "m1" },
    ],
  });
  assert.equal(r?.promote, true);
  assert.equal(r?.promoteMail, false);
  assert.equal(r?.note, null);
  assert.deepEqual(r?.attachments, [{ id: "att-1", promote: true, reason: "CV durable", categories: ["cv"] }]);
});

test("triage returns null when the model errors", async () => {
  const chat = async () => { throw new Error("gateway down"); };
  assert.equal(await triage(msg, chat), null);
});

test("triage returns null on unparseable output", async () => {
  const chat = async () => "I cannot answer that.";
  assert.equal(await triage(msg, chat), null);
});
