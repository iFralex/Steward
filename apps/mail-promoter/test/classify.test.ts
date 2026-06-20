// apps/mail-promoter/test/classify.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../src/classify.ts";

const msg = { fromName: "Anna", fromAddr: "anna@x.com", subject: "Certificati", bodyText: "Mi servono i certificati entro venerdì." };

test("classify parses a fenced JSON verdict", async () => {
  const chat = async () => '```json\n{"promote": true, "categories": ["commitment", "document"]}\n```';
  assert.deepEqual(await classify(msg, chat), { promote: true, categories: ["commitment", "document"] });
});

test("classify returns null when the model errors", async () => {
  const chat = async () => { throw new Error("gateway down"); };
  assert.equal(await classify(msg, chat), null);
});

test("classify returns null on unparseable output", async () => {
  const chat = async () => "I cannot answer that.";
  assert.equal(await classify(msg, chat), null);
});

test("classify drops out-of-allowlist categories", async () => {
  const chat = async () => '{"promote": true, "categories": ["commitment", "spam", "urgent", "document"]}';
  assert.deepEqual(await classify(msg, chat), { promote: true, categories: ["commitment", "document"] });
});
