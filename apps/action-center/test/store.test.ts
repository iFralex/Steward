import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionStore } from "../src/store.ts";

test("upsert inserts, updates active items, and preserves done items", () => {
  const s = ActionStore.open(":memory:");
  const a = s.upsert({
    sourceKey: "mail:m1",
    sourceKind: "mail",
    kind: "reply-needed",
    title: "Reply",
    summary: "First",
  });
  assert.equal(a.inserted, true);
  assert.equal(s.counts().new, 1);

  const b = s.upsert({
    sourceKey: "mail:m1",
    sourceKind: "mail",
    kind: "reply-needed",
    priority: "high",
    title: "Reply updated",
    summary: "Updated",
  });
  assert.equal(b.updated, true);
  assert.equal(s.list()[0].summary, "Updated");
  assert.equal(s.list()[0].priority, "high");

  assert.equal(s.mark(a.id, "done"), true);
  const c = s.upsert({
    sourceKey: "mail:m1",
    sourceKind: "mail",
    kind: "reply-needed",
    title: "Reply resurrected",
    summary: "Should not overwrite",
  });
  assert.equal(c.updated, false);
  assert.equal(s.list({ includeDone: true })[0].summary, "Updated");
  assert.equal(s.counts().done, 1);
  s.close();
});
