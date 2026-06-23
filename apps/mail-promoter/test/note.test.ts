// apps/mail-promoter/test/note.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNote, slugForMessageId } from "../src/note.ts";

const msg = { messageId: "abc@mail.example", fromName: "Anna", fromAddr: "anna@x.com", subject: "Detrazione", date: 1750000000, account: "ACC" };
const distilled = { summary: "Anna chiede i certificati per la detrazione.", facts: ["scadenza 30 giugno"], commitments: ["inviare certificati"], people: ["Anna"], orgs: [] };

test("slug is stable and filesystem-safe", () => {
  const a = slugForMessageId("abc@mail.example");
  assert.equal(a, slugForMessageId("abc@mail.example"));
  assert.match(a, /^[a-z0-9-]+$/);
});

test("note has frontmatter with the message:// link and the distilled body", () => {
  const { filename, content } = buildNote({ msg, accountLabel: "biz@x.com", distilled, categories: ["commitment", "document"] });
  assert.match(filename, /^mail-.*\.md$/);
  assert.match(content, /^---\n/);
  assert.match(content, /source: message:\/\/abc@mail\.example/);
  assert.match(content, /subject: Detrazione/);
  assert.match(content, /account: biz@x\.com/);
  assert.match(content, /categories: \[commitment, document\]/);
  assert.match(content, /Anna chiede i certificati/);
  assert.match(content, /- inviare certificati/);
  assert.doesNotMatch(content, /## Organizations/); // empty section omitted
  assert.doesNotMatch(content, /review_by:/); // omitted when absent
});

test("note includes review_by and thread links when present", () => {
  const { content } = buildNote({
    msg,
    accountLabel: "biz@x.com",
    distilled: { ...distilled, reviewBy: "2026-08-15" },
    categories: ["commitment"],
    threadId: 42,
    messageIds: ["a@x", "b@x"],
  });
  assert.match(content, /review_by: 2026-08-15/);
  assert.match(content, /thread: thread:\/\/42/);
  assert.match(content, /messages: \[a@x, b@x\]/);
});
