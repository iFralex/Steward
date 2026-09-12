import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSearchPage, normalizeSearchPage } from "../src/search-page.ts";
import type { MessageSummary } from "../src/types.ts";

function row(index: number): MessageSummary {
  const id = `message-${index}@example.com`;
  return {
    id,
    messageId: id,
    mailUrl: `message://${id}`,
    subject: `Subject ${index}`,
    from: "Sender <sender@example.com>",
    date: "2026-09-12T10:00:00.000Z",
    mailbox: "INBOX",
    account: "long-account-uuid",
    snippet: "s".repeat(200),
    threadId: index,
  };
}

test("mail search defaults to a compact eight-result page and fetches one look-ahead row", () => {
  const normalized = normalizeSearchPage({ query: "train" });
  assert.equal(normalized.limit, 8);
  assert.equal(normalized.fetchArgs.limit, 9);
  const page = buildSearchPage(Array.from({ length: 9 }, (_, index) => row(index)), normalized.limit, normalized.offset);
  assert.equal(page.messages.length, 8);
  assert.deepEqual(page.page, { offset: 0, returned: 8, hasMore: true, nextOffset: 8 });
  assert.equal("messageId" in page.messages[0], false);
  assert.equal("mailUrl" in page.messages[0], false);
  assert.equal("account" in page.messages[0], false);
  assert.equal(page.messages[3].snippet.length, 120);
});

test("mail search caps oversized pages and preserves the requested offset", () => {
  const normalized = normalizeSearchPage({ limit: 20, offset: 12 });
  assert.equal(normalized.limit, 12);
  assert.equal(normalized.offset, 12);
  assert.equal(normalized.fetchArgs.limit, 13);
  assert.equal(normalized.fetchArgs.offset, 12);
});
