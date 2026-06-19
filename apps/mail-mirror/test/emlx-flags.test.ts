// apps/mail-mirror/test/emlx-flags.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFlags, parsePlistTrailer } from "../src/emlx.ts";

test("decodeFlags matches real captured ground-truth integers", () => {
  // (flags int, expected) — captured from real Apple Mail messages.
  assert.deepEqual(decodeFlags(8590195840), { read: false, answered: false, flagged: false, junk: false });
  assert.deepEqual(decodeFlags(8590195713), { read: true, answered: false, flagged: false, junk: false });
  assert.deepEqual(decodeFlags(8590195856), { read: false, answered: false, flagged: true, junk: false });
  assert.deepEqual(decodeFlags(8606973056), { read: false, answered: false, flagged: false, junk: true });
  assert.deepEqual(decodeFlags(25770065029), { read: true, answered: true, flagged: false, junk: false });
});

test("parsePlistTrailer extracts flags/color/conversation-id from the trailing plist", () => {
  const trailer = Buffer.from(
    `5\nhello<?xml version="1.0"?>\n<plist version="1.0"><dict>` +
    `<key>color</key><integer>0</integer>` +
    `<key>conversation-id</key><integer>80147</integer>` +
    `<key>flags</key><integer>8590195856</integer>` +
    `</dict></plist>\n`,
  );
  const p = parsePlistTrailer(trailer);
  assert.equal(p.flags, 8590195856);
  assert.equal(p.color, 0);
  assert.equal(p.appleThrid, 80147);
});

test("parsePlistTrailer returns nulls when there is no plist", () => {
  assert.deepEqual(parsePlistTrailer(Buffer.from("3\nhi")), { flags: null, color: null, appleThrid: null });
});
