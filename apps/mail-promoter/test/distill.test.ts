// apps/mail-promoter/test/distill.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { distill } from "../src/distill.ts";

const msg = { fromName: "Anna", fromAddr: "anna@x.com", subject: "Certificati", bodyText: "Mi servono i certificati entro venerdì." };

test("distill parses a JSON note", async () => {
  const chat = async () => '{"summary":"Anna chiede certificati","facts":["entro venerdì"],"commitments":["inviare certificati"],"people":["Anna"],"orgs":[]}';
  const r = await distill(msg, chat);
  assert.equal(r?.summary, "Anna chiede certificati");
  assert.deepEqual(r?.commitments, ["inviare certificati"]);
});

test("distill returns null on error", async () => {
  assert.equal(await distill(msg, async () => { throw new Error("x"); }), null);
});
