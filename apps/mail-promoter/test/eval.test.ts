// apps/mail-promoter/test/eval.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, type LabelledItem } from "../src/eval.ts";

const mk = (id: string, label: "promote" | "skip", subject: string): LabelledItem => ({
  messageId: id, label, msg: { fromAddr: "a@x.com", fromName: "A", subject, bodyText: "body", bodyState: "full" },
});

test("evaluate computes precision/recall against labels", async () => {
  const items = [mk("1", "promote", "Certificati"), mk("2", "skip", "Hi"), mk("3", "promote", "Contratto")];
  // model promotes anything whose subject is not "Hi"
  const chat = async (_s: string, user: string) => (user.includes("Hi") ? '{"promote":false,"categories":[]}' : '{"promote":true,"categories":[]}');
  const r = await evaluate(items, chat);
  assert.equal(r.tp, 2); // 1 and 3 promoted correctly
  assert.equal(r.tn, 1); // 2 skipped correctly
  assert.equal(r.fp, 0);
  assert.equal(r.fn, 0);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
});
