import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { Mail } from "../src/mail.ts";

/** Minimal in-memory store for tests that do not exercise DB behaviour. */
function emptyStore(): Store {
  return Store.open(":memory:");
}

function row(id: string, subject: string, body: string): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "T", fromAddr: "a@b",
    to: ["me@x"], cc: [], subject, date: 1750000000, bodyText: body, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

test("send validates recipients then runs the send script", async () => {
  let ran = "";
  const mail = new Mail({
    store: emptyStore(),
    runner: async (s) => { ran = s; return "sent"; },
  });
  const res = await mail.send({ to: ["a@b.co"], subject: "hi", body: "yo" });
  assert.deepEqual(res, { sent: true });
  assert.ok(ran.includes("make new outgoing message"));
  assert.ok(/\bsend\b/.test(ran));
});

test("send rejects an invalid `from` address without running anything", async () => {
  let ran = false;
  const mail = new Mail({
    store: emptyStore(),
    runner: async () => { ran = true; return ""; },
  });
  await assert.rejects(
    () => mail.send({ from: "Polimi", to: ["a@b.co"], subject: "x", body: "y" }),
    /account email addresses/,
  );
  assert.equal(ran, false);
});

test("send rejects an invalid recipient without running anything", async () => {
  let ran = false;
  const mail = new Mail({
    store: emptyStore(),
    runner: async () => { ran = true; return ""; },
  });
  await assert.rejects(() => mail.send({ to: ["bad"], subject: "x", body: "y" }), /invalid email/);
  assert.equal(ran, false);
});

test("search returns DB results", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("id1", "S", "body a@b sender"));
  const mail = new Mail({ store: s });
  const rows = await mail.search({ sender: "a@b" });
  assert.equal(rows[0].messageId, "id1");
  s.close();
});

test("search query matches via FTS", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("id1", "About cats", "cats body"));
  s.upsertMessage(row("id2", "About dogs", "dogs body"));
  const mail = new Mail({ store: s });
  const rows = await mail.search({ query: "cats" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, "id1");
  s.close();
});
