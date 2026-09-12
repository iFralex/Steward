import assert from "node:assert/strict";
import test from "node:test";
import { buildThreadPage } from "../src/thread-page.ts";
import type { MessageSummary } from "../src/types.ts";

const row = (index: number): MessageSummary => ({
  id: `message-${index}@example.com`,
  messageId: `message-${index}@example.com`,
  mailUrl: `message://message-${index}@example.com`,
  subject: "A conversation",
  from: `Person ${index} <person${index}@example.com>`,
  date: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  mailbox: index % 2 ? "Sent" : "Inbox",
  account: "me@example.com",
  snippet: `${index}: ${"x".repeat(250)}`,
  threadId: 42,
});

test("defaults to the latest 10 messages while preserving chronological order", () => {
  const page = buildThreadPage(Array.from({ length: 25 }, (_, i) => row(i)));
  assert.equal(page.messages.length, 10);
  assert.equal(page.messages[0].id, "message-15@example.com");
  assert.equal(page.messages.at(-1)?.id, "message-24@example.com");
  assert.deepEqual(page.page, {
    total: 25,
    offset: 15,
    returned: 10,
    hasEarlier: true,
    earlierOffset: 5,
    hasLater: false,
  });
});

test("supports navigating to an earlier page", () => {
  const page = buildThreadPage(Array.from({ length: 45 }, (_, i) => row(i)), { limit: 10, offset: 10 });
  assert.equal(page.messages[0].id, "message-10@example.com");
  assert.deepEqual(page.page, {
    total: 45,
    offset: 10,
    returned: 10,
    hasEarlier: true,
    earlierOffset: 0,
    hasLater: true,
    laterOffset: 20,
  });
});

test("keeps actionable metadata but removes duplicate per-message fields", () => {
  const page = buildThreadPage([row(0)]);
  const message = page.messages[0] as unknown as Record<string, unknown>;
  assert.equal(message.id, "message-0@example.com");
  assert.equal(message.mailUrl, "message://message-0@example.com");
  assert.equal(message.account, "me@example.com");
  assert.equal(message.mailbox, "Inbox");
  assert.equal("messageId" in message, false);
  assert.equal("threadId" in message, false);
});

test("uses shorter snippets except for the last three messages in a page", () => {
  const page = buildThreadPage(Array.from({ length: 5 }, (_, i) => row(i)));
  assert.ok(page.messages[0].snippet.length <= 80);
  assert.ok(page.messages[1].snippet.length <= 80);
  assert.ok(page.messages[2].snippet.length <= 180);
  assert.ok(page.messages[4].snippet.length <= 180);
});
