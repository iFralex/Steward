import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSummaries, parseMailboxes, parseDetail } from "../src/parse.ts";

const US = "\x1f";
const RS = "\x1e";

test("parseSummaries splits records and fields", () => {
  const out = ["id1", "Subj", "a@b", "2026", "Inbox", "acct", "snip"].join(US) + RS;
  const rows = parseSummaries(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, "id1");
  assert.equal(rows[0].subject, "Subj");
  assert.equal(rows[0].mailbox, "Inbox");
});

test("parseMailboxes parses account, emails, name", () => {
  const out =
    ["Gmail", "a@gmail.com, a2@gmail.com", "Sent"].join(US) + RS +
    ["Polimi", "alessio.antonucci@mail.polimi.it", "Drafts"].join(US) + RS;
  assert.deepEqual(parseMailboxes(out), [
    { account: "Gmail", emails: ["a@gmail.com", "a2@gmail.com"], name: "Sent" },
    { account: "Polimi", emails: ["alessio.antonucci@mail.polimi.it"], name: "Drafts" },
  ]);
});

test("parseDetail reads subject/from/date/body", () => {
  const out = ["Subj", "a@b", "2026", "hello\nbody"].join(US);
  assert.deepEqual(parseDetail(out), { subject: "Subj", from: "a@b", date: "2026", body: "hello\nbody" });
});
