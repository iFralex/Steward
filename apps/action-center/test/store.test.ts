import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionStore } from "../src/store.ts";

test("Action automation defaults on and records a fresh cutoff when re-enabled", () => {
  const s = ActionStore.open(":memory:");
  assert.deepEqual(s.getAutomationSettings(), { enabled: true, enabledAt: null, updatedAt: null });
  assert.deepEqual(s.setAutomationEnabled(false, 100), { enabled: false, enabledAt: null, updatedAt: 100 });
  assert.deepEqual(s.setAutomationEnabled(true, 200), { enabled: true, enabledAt: 200, updatedAt: 200 });
  assert.deepEqual(s.setAutomationEnabled(true, 300), { enabled: true, enabledAt: 200, updatedAt: 200 });
  s.close();
});

test("upsert can merge a related thread into one action and remembers both sources", () => {
  const s = ActionStore.open(":memory:");
  const first = s.upsert({
    sourceKey: "mail:thread:10",
    sourceKind: "mail",
    kind: "admin-task",
    title: "Card suspended",
    summary: "Fineco suspended card ****5675.",
    payload: { threadId: 10, contextSnapshot: { mail: { from: "Fineco <service@finecobank.com>" } } },
  });
  const merged = s.upsert({
    sourceKey: "mail:thread:20",
    sourceKind: "mail",
    kind: "admin-task",
    title: "Card fully blocked",
    summary: "Fineco later extended the block to every function.",
    payload: { threadId: 20, contextSnapshot: { mail: { from: "Fineco <service@finecobank.com>" } } },
  }, { mergeIntoId: first.id });

  assert.equal(merged.id, first.id);
  assert.equal(s.list().length, 1);
  const item = s.get(first.id)!;
  assert.equal(item.sourceKey, "mail:thread:10");
  assert.deepEqual(item.payload.relatedSourceKeys, ["mail:thread:20"]);
  assert.deepEqual(item.payload.relatedThreadIds, [10, 20]);
  const history = item.payload.relatedHistory as Record<string, unknown>[];
  assert.equal(history.length, 1);
  assert.equal("contextSnapshot" in history[0], false, "merged history must not duplicate potentially large tool observations");
  const same = s.upsert({
    sourceKey: "mail:thread:20",
    sourceKind: "mail",
    kind: "admin-task",
    title: "Card still blocked",
    summary: "No change.",
    payload: { threadId: 20 },
  });
  assert.equal(same.id, first.id, "a related source key must resolve to the merged action later");
  assert.equal(s.list().length, 1);
  s.close();
});

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

test("list({status}) filters to that exact status, overriding includeDone", () => {
  const s = ActionStore.open(":memory:");
  const a = s.upsert({ sourceKey: "k1", sourceKind: "mail", kind: "reply-needed", title: "a", summary: "a" });
  const b = s.upsert({ sourceKey: "k2", sourceKind: "mail", kind: "reply-needed", title: "b", summary: "b" });
  s.mark(a.id, "read");
  s.mark(b.id, "done");

  assert.deepEqual(s.list({ status: "read" }).map((x) => x.id), [a.id]);
  assert.deepEqual(s.list({ status: "done" }).map((x) => x.id), [b.id]);
  assert.deepEqual(s.list({ status: "new" }).map((x) => x.id), []);
  s.close();
});

test("list({kind}) filters to that action kind", () => {
  const s = ActionStore.open(":memory:");
  const a = s.upsert({ sourceKey: "k1", sourceKind: "mail", kind: "reply-needed", title: "a", summary: "a" });
  s.upsert({ sourceKey: "k2", sourceKind: "mail", kind: "deadline", title: "b", summary: "b" });

  assert.deepEqual(s.list({ kind: "reply-needed" }).map((x) => x.id), [a.id]);
  s.close();
});

test("list({status, kind}) combines both filters", () => {
  const s = ActionStore.open(":memory:");
  const a = s.upsert({ sourceKey: "k1", sourceKind: "mail", kind: "deadline", title: "a", summary: "a" });
  const b = s.upsert({ sourceKey: "k2", sourceKind: "mail", kind: "deadline", title: "b", summary: "b" });
  s.upsert({ sourceKey: "k3", sourceKind: "mail", kind: "reply-needed", title: "c", summary: "c" });
  s.mark(b.id, "done");

  assert.deepEqual(s.list({ status: "new", kind: "deadline" }).map((x) => x.id), [a.id]);
  s.close();
});

test("updateSummary changes the summary without touching status", () => {
  const s = ActionStore.open(":memory:");
  const { id } = s.upsert({
    sourceKey: "k",
    sourceKind: "mail",
    kind: "follow-up",
    title: "t",
    summary: "original summary",
  });
  s.mark(id, "read");
  const ok = s.updateSummary(id, "reply arrived: resolved in ~10 business days");
  assert.equal(ok, true);
  const after = s.get(id)!;
  assert.equal(after.summary, "reply arrived: resolved in ~10 business days");
  assert.equal(after.status, "read", "must not touch status");
  s.close();
});

test("updateSummary returns false for an unknown id", () => {
  const s = ActionStore.open(":memory:");
  assert.equal(s.updateSummary(999999, "x"), false);
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
