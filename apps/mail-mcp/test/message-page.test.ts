import assert from "node:assert/strict";
import test from "node:test";
import { buildMessagePage } from "../src/message-page.ts";
import type { MailDetail } from "../src/db-read.ts";

function detail(body: string): MailDetail {
  return {
    subject: "Important message",
    from: "Sender <sender@example.com>",
    date: "2026-09-12T10:00:00.000Z",
    body,
    attachments: [{ name: "document.pdf", index: 1 }],
    bodyState: "full",
    mailUrl: "message://important@example.com",
  };
}

test("returns a complete short body with pagination metadata", () => {
  const page = buildMessagePage(detail("Short exact body"));
  assert.equal(page.body, "Short exact body");
  assert.deepEqual(page.bodyPage, {
    totalChars: 16,
    offset: 0,
    returnedChars: 16,
    hasEarlier: false,
    hasMore: false,
  });
  assert.equal(page.mailUrl, "message://important@example.com");
  assert.deepEqual(page.attachments, [{ name: "document.pdf", index: 1 }]);
});

test("returns the first 5000 exact characters and a continuation offset", () => {
  const original = `${"a".repeat(5_000)}https://example.com/action`;
  const page = buildMessagePage(detail(original));
  assert.equal(page.body, original.slice(0, 5_000));
  assert.deepEqual(page.bodyPage, {
    totalChars: original.length,
    offset: 0,
    returnedChars: 5_000,
    hasEarlier: false,
    hasMore: true,
    nextOffset: 5_000,
  });
});

test("continues from bodyOffset without changing content", () => {
  const original = `${"a".repeat(5_000)}https://example.com/action`;
  const page = buildMessagePage(detail(original), { bodyOffset: 5_000, bodyLimit: 100 });
  assert.equal(page.body, "https://example.com/action");
  assert.deepEqual(page.bodyPage, {
    totalChars: original.length,
    offset: 5_000,
    returnedChars: 26,
    hasEarlier: true,
    earlierOffset: 4_900,
    hasMore: false,
  });
});

test("caps oversized page requests", () => {
  const page = buildMessagePage(detail("x".repeat(20_000)), { bodyLimit: 99_999 });
  assert.equal(page.body.length, 12_000);
  assert.equal(page.bodyPage.nextOffset, 12_000);
});
