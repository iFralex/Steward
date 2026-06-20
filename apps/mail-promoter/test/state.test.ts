// apps/mail-promoter/test/state.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { PromoteState } from "../src/state.ts";

test("needsProcessing: true when unseen, false after record with same hash, true after hash change", () => {
  const s = PromoteState.open(":memory:");
  assert.equal(s.needsProcessing("m1", "h1"), true);
  s.record({ messageId: "m1", decision: "skipped", categories: [], classifyModel: "local-chat", distillModel: null, wikiFilename: null, sourceHash: "h1" });
  assert.equal(s.needsProcessing("m1", "h1"), false);
  assert.equal(s.needsProcessing("m1", "h2"), true);
  s.close();
});

test("record stores a promotion and get returns the decision + hash", () => {
  const s = PromoteState.open(":memory:");
  s.record({ messageId: "m2", decision: "promoted", categories: ["commitment"], classifyModel: "local-chat", distillModel: "sub-opus", wikiFilename: "mail-m2.md", sourceHash: "hh" });
  assert.deepEqual(s.get("m2"), { decision: "promoted", sourceHash: "hh" });
  s.close();
});
