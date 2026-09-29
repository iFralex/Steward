import assert from "node:assert/strict";
import test from "node:test";
import { isInlineCardLanguage, normalizeInlineCardMarkdown, parseInlineCardJson } from "../src/lib/inline-cards.ts";

test("normalizes a card language placed on the line after the opening fence", () => {
  const input = ["Before", "", "```", "card", '{"type":"event","summary":"Demo"}', "```", "", "After"].join("\n");
  const expected = ["Before", "", "```card", '{"type":"event","summary":"Demo"}', "```", "", "After"].join("\n");
  assert.equal(normalizeInlineCardMarkdown(input), expected);
});

test("normalizes case and whitespace variants without touching ordinary fences", () => {
  assert.equal(
    normalizeInlineCardMarkdown("~~~\n Card  \n{\"type\":\"file\"}\n~~~"),
    "~~~card\n{\"type\":\"file\"}\n~~~",
  );
  assert.equal(normalizeInlineCardMarkdown("```\njson\n{}\n```"), "```\njson\n{}\n```");
});

test("recognizes card language among additional classes and regardless of case", () => {
  assert.equal(isInlineCardLanguage("language-card"), true);
  assert.equal(isInlineCardLanguage("highlight LANGUAGE-CARD extra"), true);
  assert.equal(isInlineCardLanguage("language-json"), false);
});

test("parses valid flat and envelope cards", () => {
  assert.deepEqual(parseInlineCardJson('{"type":"EVENT","summary":"Demo"}'), {
    type: "event",
    data: { summary: "Demo" },
  });
  assert.deepEqual(parseInlineCardJson('{"type":"file","data":{"path":"/tmp/a"}}'), {
    type: "file",
    data: { data: { path: "/tmp/a" } },
  });
});

test("keeps incomplete, invalid, or untyped payloads as ordinary code", () => {
  assert.equal(parseInlineCardJson('{"type":"event"'), null);
  assert.equal(parseInlineCardJson('{"summary":"Demo"}'), null);
  assert.equal(parseInlineCardJson('[{"type":"event"}]'), null);
  assert.equal(parseInlineCardJson('{"type":"unknown","value":1}'), null);
});
