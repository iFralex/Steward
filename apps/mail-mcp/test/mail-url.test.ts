import assert from "node:assert/strict";
import { test } from "node:test";
import { mailUrl } from "../src/mail-url.ts";

test("mailUrl builds a clickable Apple Mail deep link (angle brackets URL-encoded)", () => {
  assert.equal(mailUrl("26062120-0102@NTV.PRD.15below.com"), "message://%3C26062120-0102@NTV.PRD.15below.com%3E");
});
