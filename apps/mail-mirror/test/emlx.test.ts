import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeId, parseEmlx, sliceMessageBytes } from "../src/emlx.ts";

function makeEmlx(rfc: string): Buffer {
  const plist = '<?xml version="1.0"?><plist><dict></dict></plist>\n';
  const body = Buffer.from(rfc, "utf8");
  const header = Buffer.from(String(body.length) + "    \n", "utf8");
  return Buffer.concat([header, body, Buffer.from(plist, "utf8")]);
}

const RFC =
  "From: CartaFreccia <noreply@trenitalia.it>\r\n" +
  "To: me@example.com\r\n" +
  "Subject: =?UTF-8?B?8J+nsyAtMjAl?=\r\n" +
  "Message-ID: <abc123@trenitalia.it>\r\n" +
  "In-Reply-To: <root99@trenitalia.it>\r\n" +
  "References: <root99@trenitalia.it> <mid50@trenitalia.it>\r\n" +
  "Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
  "--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCodice FRECCIA20.\r\n" +
  "--B\r\nContent-Type: application/pdf; name=p.pdf\r\n" +
  "Content-Disposition: attachment; filename=p.pdf\r\n" +
  "Content-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--B--\r\n";

test("normalizeId strips angle brackets and whitespace", () => {
  assert.equal(normalizeId("  <abc@x>  "), "abc@x");
  assert.equal(normalizeId(""), null);
  assert.equal(normalizeId(undefined), null);
});

test("sliceMessageBytes returns exactly the RFC822 message (by byte count)", () => {
  const emlx = makeEmlx(RFC);
  const msg = sliceMessageBytes(emlx).toString("utf8");
  assert.ok(msg.startsWith("From: CartaFreccia"));
  assert.ok(msg.trimEnd().endsWith("--B--"));
  assert.ok(!msg.includes("<plist>"));
});

test("parseEmlx collects all addresses when To has multiple recipients", async () => {
  const rfc =
    "From: sender@example.com\r\n" +
    "To: a@x.com, b@x.com\r\n" +
    "Subject: Multi-recipient\r\n" +
    "Message-ID: <multi@example.com>\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
    "body\r\n";
  const m = await parseEmlx(makeEmlx(rfc));
  assert.ok(m.to.includes("a@x.com"), "should include a@x.com");
  assert.ok(m.to.includes("b@x.com"), "should include b@x.com");
  assert.equal(m.to.length, 2);
});

test("parseEmlx extracts headers, body, threading, attachments", async () => {
  const m = await parseEmlx(makeEmlx(RFC));
  assert.equal(m.messageId, "abc123@trenitalia.it");
  assert.equal(m.fromAddr, "noreply@trenitalia.it");
  assert.ok(m.subject.includes("-20%"));
  assert.ok(m.bodyText.includes("FRECCIA20"));
  assert.equal(m.inReplyTo, "root99@trenitalia.it");
  assert.deepEqual(m.references, ["root99@trenitalia.it", "mid50@trenitalia.it"]);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, "p.pdf");
});
