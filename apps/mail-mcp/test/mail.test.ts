import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { Mail } from "../src/mail.ts";
import { WriteOpsStore } from "@steward/write-ops";
import { assertSafeDestPath } from "../src/validate.ts";
import { homedir } from "node:os";
import { join } from "node:path";

/** Minimal in-memory store for tests that do not exercise DB behaviour. */
function emptyStore(): Store {
  return Store.open(":memory:");
}

function row(id: string, subject: string, body: string): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "T", fromAddr: "a@b",
    to: ["me@x"], cc: [], subject, date: 1750000000, bodyText: body, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
    toNames: [], ccNames: [], unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null,
  };
}

test("saveAttachment falls back to AppleScript when the message isn't in the mirror", async () => {
  let ran = false;
  const mail = new Mail({ store: emptyStore(), runner: async () => { ran = true; return "/tmp/x.pdf"; } });
  const r = await mail.saveAttachment({ messageId: "missing@x", attachment: "x.pdf", destDir: "/tmp" });
  assert.equal(ran, true, "no mirror row → live AppleScript save");
  assert.equal(r.path, "/tmp/x.pdf");
});

test("send with sendAt queues the email and does NOT run AppleScript", async () => {
  const writeOps = WriteOpsStore.open(":memory:");
  let ran = false;
  const mail = new Mail({ store: emptyStore(), writeOps, runner: async () => { ran = true; return "sent"; } });
  const r = await mail.send({ to: ["a@b.co"], subject: "x", body: "later", sendAt: "2099-01-01T09:00:00Z" });
  assert.equal(ran, false, "must not send immediately");
  assert.ok("scheduled" in r && r.scheduled === true);
  assert.equal(writeOps.listScheduled().length, 1);
  writeOps.close();
});

test("reply with sendAt queues; an invalid sendAt is rejected", async () => {
  const writeOps = WriteOpsStore.open(":memory:");
  const mail = new Mail({ store: emptyStore(), writeOps, runner: async () => "sent" });
  const r = await mail.reply({ messageId: "m@x", body: "later", sendAt: "2099-01-01T09:00:00Z" });
  assert.ok("scheduled" in r && r.scheduled === true);
  assert.equal(writeOps.listScheduled().length, 1);
  await assert.rejects(() => mail.reply({ messageId: "m@x", body: "x", sendAt: "not-a-date" }), /ISO 8601/);
  writeOps.close();
});

test("listMailboxes is served from the mirror (no AppleScript) with account name + emails", async () => {
  const s = emptyStore();
  s.upsertMessage(row("m1@x", "hi", "body"));
  s.raw.prepare("INSERT INTO accounts(uuid, name, emails) VALUES (?,?,?)").run("ACC", "Polimi", "alessio@polimi.it");
  const mail = new Mail({ store: s, runner: async () => { throw new Error("AppleScript must not run"); } });
  const boxes = await mail.listMailboxes();
  assert.ok(boxes.some((b) => b.name === "INBOX" && b.account === "Polimi" && b.emails.includes("alessio@polimi.it")));
  s.close();
});

test("listMailboxes falls back to AppleScript when the mirror is empty", async () => {
  const US = "\x1f", RS = "\x1e";
  const mail = new Mail({ store: emptyStore(), runner: async () => ["Polimi", "a@polimi.it", "INBOX"].join(US) + RS });
  const boxes = await mail.listMailboxes();
  assert.equal(boxes[0]?.name, "INBOX");
  assert.deepEqual(boxes[0]?.emails, ["a@polimi.it"]);
});

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

test("reply/send use a long write timeout (Exchange round-trip)", async () => {
  let replyTimeout: number | undefined, sendTimeout: number | undefined;
  const mail = new Mail({ store: emptyStore(), runner: async (_s, t) => { replyTimeout = sendTimeout = t; return "sent"; } });
  await mail.reply({ messageId: "m@x", body: "ok" });
  assert.ok(replyTimeout && replyTimeout >= 120_000, `reply timeout too short: ${replyTimeout}`);
  await mail.send({ to: ["a@b.co"], subject: "x", body: "y" });
  assert.ok(sendTimeout && sendTimeout >= 120_000, `send timeout too short: ${sendTimeout}`);
});

test("reply rejects an empty body without running anything", async () => {
  let ran = false;
  const mail = new Mail({
    store: emptyStore(),
    runner: async () => { ran = true; return ""; },
  });
  await assert.rejects(() => mail.reply({ messageId: "m@x", body: "   " }), /reply body must not be empty/);
  assert.equal(ran, false);
});

test("reply rejects an invalid `from` address without running anything", async () => {
  let ran = false;
  const mail = new Mail({
    store: emptyStore(),
    runner: async () => { ran = true; return ""; },
  });
  await assert.rejects(
    () => mail.reply({ messageId: "m@x", from: "Polimi", body: "ok" }),
    /not a valid email address/,
  );
  assert.equal(ran, false);
});

test("send/reply writes are serialized", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const mail = new Mail({
    store: emptyStore(),
    runner: async (script) => {
      const kind = script.includes("make new outgoing message") ? "send" : "reply";
      events.push(`${kind}:start`);
      if (kind === "send") await firstDone;
      events.push(`${kind}:end`);
      return "sent";
    },
  });
  const send = mail.send({ to: ["a@b.co"], subject: "x", body: "y" });
  const reply = mail.reply({ messageId: "m@x", body: "ok" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["send:start"]);
  releaseFirst();
  await Promise.all([send, reply]);
  assert.deepEqual(events, ["send:start", "send:end", "reply:start", "reply:end"]);
});

test("send rejects an invalid `from` address without running anything", async () => {
  let ran = false;
  const mail = new Mail({
    store: emptyStore(),
    runner: async () => { ran = true; return ""; },
  });
  await assert.rejects(
    () => mail.send({ from: "Polimi", to: ["a@b.co"], subject: "x", body: "y" }),
    /not a valid email address/,
  );
  assert.equal(ran, false);
});

test("send does not retry a transient-looking AppleScript failure (write-ops owns retries)", async () => {
  let calls = 0;
  const mail = new Mail({
    store: emptyStore(),
    runner: async (_script, _timeoutMs, opts) => {
      calls += 1;
      assert.equal(opts?.retryTransient, false, "send must disable the low-level transient retry");
      throw new Error("Mail connection was temporarily invalid (-609).");
    },
  });
  await assert.rejects(() => mail.send({ to: ["a@b.co"], subject: "x", body: "y" }));
  assert.equal(calls, 1, "runner must be invoked exactly once — no low-level retry on a write");
});

test("reply does not retry a transient-looking AppleScript failure (write-ops owns retries)", async () => {
  let calls = 0;
  const mail = new Mail({
    store: emptyStore(),
    runner: async (_script, _timeoutMs, opts) => {
      calls += 1;
      assert.equal(opts?.retryTransient, false, "reply must disable the low-level transient retry");
      throw new Error("Mail connection was temporarily invalid (-609).");
    },
  });
  await assert.rejects(() => mail.reply({ messageId: "m@x", body: "ok" }));
  assert.equal(calls, 1, "runner must be invoked exactly once — no low-level retry on a write");
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

test("search forwards field-scoped + rich filters to the DB layer", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("id1", "Invoice", "body"));
  // give it a recipient name to match toName — update both messages and messages_trig
  s.raw.prepare("UPDATE messages SET to_names=? WHERE message_id='id1'").run(JSON.stringify(["Cristiana Rossi"]));
  const rowid = (s.raw.prepare("SELECT rowid FROM messages WHERE message_id='id1'").get() as { rowid: number }).rowid;
  s.raw.prepare("UPDATE messages_trig SET to_names=? WHERE rowid=?").run(JSON.stringify(["Cristiana Rossi"]), rowid);
  s.upsertMessage(row("id2", "Other", "body"));
  const mail = new Mail({ store: s });
  const rows = await mail.search({ toName: "ristian" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, "id1");
  s.close();
});

test("getThread returns the conversation", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a", "S", "b"));
  s.upsertMessage(row("c", "S", "b"));
  s.setThreadId("a", 3); s.setThreadId("c", 3);
  const mail = new Mail({ store: s });
  const out = await mail.getThread({ messageId: "a" });
  assert.equal(out.length, 2);
  s.close();
});

test("assertSafeDestPath rejects persistence and secret directories", () => {
  const bad = [
    join(homedir(), "Library", "LaunchAgents"),
    "/Library/LaunchDaemons",
    join(homedir(), ".ssh"),
    join(homedir(), ".aws"),
    "/etc/cron.d",
    "/usr/local/bin",
    "/private/etc/cron.d",
    "/private/var/at/jobs",
    "/ETC/cron.d",
    join(homedir(), ".SSH"),
    join(homedir(), "LIBRARY", "LaunchAgents"),
  ];
  for (const dir of bad) assert.throws(() => assertSafeDestPath(dir), new RegExp("not allowed"));
  assert.equal(assertSafeDestPath(join(homedir(), "Documents")), join(homedir(), "Documents"));
});
