// apps/mail-mirror/test/emlx-names.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEmlx } from "../src/emlx.ts";

test("parseEmlx captures recipient and cc display names", async () => {
  const raw =
    "From: A <a@x.com>\r\n" +
    "To: Cristiana Rossi <cris@x.com>, nobody@y.com\r\n" +
    "Cc: Marco Bianchi <marco@z.com>\r\n" +
    "Subject: hi\r\n\r\nbody\r\n";
  const buf = Buffer.from(`${Buffer.byteLength(raw)}\n${raw}`);
  const p = await parseEmlx(buf);
  assert.deepEqual(p.to, ["cris@x.com", "nobody@y.com"]);
  assert.deepEqual(p.toNames, ["Cristiana Rossi", ""]);
  assert.deepEqual(p.cc, ["marco@z.com"]);
  assert.deepEqual(p.ccNames, ["Marco Bianchi"]);
});
