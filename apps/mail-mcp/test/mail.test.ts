import assert from "node:assert/strict";
import { test } from "node:test";
import { Mail } from "../src/mail.ts";

const US = "\x1f";
const RS = "\x1e";

test("send validates recipients then runs the send script", async () => {
  let ran = "";
  const mail = new Mail(async (s) => {
    ran = s;
    return "sent";
  });
  const res = await mail.send({ to: ["a@b.co"], subject: "hi", body: "yo" });
  assert.deepEqual(res, { sent: true });
  assert.ok(ran.includes("make new outgoing message"));
  assert.ok(/\bsend\b/.test(ran));
});

test("send rejects an invalid recipient without running anything", async () => {
  let ran = false;
  const mail = new Mail(async () => {
    ran = true;
    return "";
  });
  await assert.rejects(() => mail.send({ to: ["bad"], subject: "x", body: "y" }), /invalid email/);
  assert.equal(ran, false);
});

test("search returns parsed summaries", async () => {
  const out = ["id1", "S", "a@b", "2026", "Inbox", "", ""].join(US) + RS;
  const mail = new Mail(async () => out);
  const rows = await mail.search({ sender: "a@b" });
  assert.equal(rows[0].messageId, "id1");
});

test("search query post-filters on subject", async () => {
  const out =
    ["id1", "About cats", "a@b", "2026", "Inbox", "", ""].join(US) + RS +
    ["id2", "About dogs", "a@b", "2026", "Inbox", "", ""].join(US) + RS;
  const mail = new Mail(async () => out);
  const rows = await mail.search({ query: "cats" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, "id1");
});
