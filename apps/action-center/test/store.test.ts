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

test("get(id) returns one action regardless of list limits", () => {
  const s = ActionStore.open(":memory:");
  const { id } = s.upsert({
    sourceKey: "k",
    sourceKind: "mail",
    kind: "reply-needed",
    priority: "normal",
    title: "t",
    summary: "s",
    dueAt: null,
    payload: {},
  });
  const row = s.get(id);
  assert.equal(row?.title, "t");
  assert.equal(s.get(999999), null);
  s.close();
});

test("mail thread source key migrates old message-keyed active rows", () => {
  const s = ActionStore.open(":memory:");
  s.upsert({
    sourceKey: "mail:m1",
    sourceKind: "mail",
    kind: "reply-needed",
    title: "Old",
    summary: "Old message-keyed row",
    payload: { messageId: "m1", threadId: 42, date: 100 },
  });

  const updated = s.upsert({
    sourceKey: "mail:thread:42",
    sourceKind: "mail",
    kind: "reply-needed",
    title: "New",
    summary: "Updated thread row",
    payload: { messageId: "m2", threadId: 42, date: 200 },
  });

  assert.equal(updated.updated, true);
  const all = s.list({ includeDone: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].sourceKey, "mail:thread:42");
  assert.equal(all[0].payload.messageId, "m2");
  s.close();
});

test("newer mail in handled thread reopens the action", () => {
  const s = ActionStore.open(":memory:");
  const inserted = s.upsert({
    sourceKey: "mail:thread:7",
    sourceKind: "mail",
    kind: "reply-needed",
    title: "Thread",
    summary: "Handled",
    payload: { messageId: "m1", threadId: 7, date: 100 },
  });
  s.mark(inserted.id, "done");

  const updated = s.upsert({
    sourceKey: "mail:thread:7",
    sourceKind: "mail",
    kind: "reply-needed",
    title: "Thread",
    summary: "New message",
    payload: { messageId: "m2", threadId: 7, date: 200 },
  });

  assert.equal(updated.updated, true);
  assert.equal(s.counts().new, 1);
  assert.equal(s.list()[0].summary, "New message");
  s.close();
});
