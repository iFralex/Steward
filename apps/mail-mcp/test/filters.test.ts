import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFilterSql } from "../src/filters.ts";

test("empty filters only exclude deleted", () => {
  const { clause, params } = buildFilterSql({});
  assert.equal(clause, "m.deleted=0");
  assert.deepEqual(params, []);
});

test("filters compose with params in order", () => {
  const { clause, params } = buildFilterSql({
    account: "ACC", mailbox: "INBOX", sender: "trenitalia",
    dateFrom: 1000, dateTo: 2000, unreadOnly: true, flaggedOnly: true, hasAttachments: true,
  });
  assert.match(clause, /m\.deleted=0/);
  assert.match(clause, /m\.account=\?/);
  assert.match(clause, /m\.mailbox=\?/);
  assert.match(clause, /from_addr LIKE \? OR m\.from_name LIKE \?/);
  assert.match(clause, /m\.date>=\? AND m\.date<=\?/);
  assert.match(clause, /m\.unread=1/);
  assert.match(clause, /m\.flagged=1/);
  assert.match(clause, /EXISTS \(SELECT 1 FROM attachments/);
  assert.deepEqual(params, ["ACC", "INBOX", "%trenitalia%", "%trenitalia%", 1000, 2000]);
});

test("subject filter generates LIKE clause with wildcard params", () => {
  const { clause, params } = buildFilterSql({ subject: "Protiviti" });
  assert.match(clause, /m\.subject LIKE \?/);
  assert.deepEqual(params, ["%Protiviti%"]);
});

test("scalar enrichment filters emit clauses + params", () => {
  const { clause, params } = buildFilterSql({
    answeredOnly: true, junkOnly: true, cc: "boss@x", senderDomain: "polimi.it",
    attachmentType: "pdf", attachmentName: "fattura", minSize: 1000, maxSize: 5000,
  });
  assert.match(clause, /m\.answered=1/);
  assert.match(clause, /m\.junk=1/);
  assert.match(clause, /cc_addrs LIKE \? OR m\.cc_names LIKE \?/);
  assert.match(clause, /m\.from_addr LIKE \?/);          // senderDomain
  assert.match(clause, /a\.mime LIKE \? OR a\.filename LIKE \?/); // attachmentType
  assert.match(clause, /a\.filename LIKE \?/);            // attachmentName
  assert.match(clause, /m\.size>=\?/);
  assert.match(clause, /m\.size<=\?/);
  assert.ok(params.includes("%boss@x%"));
  assert.ok(params.includes("%@polimi.it"));   // senderDomain anchored
  assert.ok(params.includes(1000) && params.includes(5000));
});

test("mailboxNames with anyMailbox uses message_paths EXISTS", () => {
  const a = buildFilterSql({ mailboxNames: ["Bozze", "Drafts"], anyMailbox: true });
  assert.match(a.clause, /EXISTS \(SELECT 1 FROM message_paths mp WHERE mp\.message_id=m\.message_id AND mp\.mailbox IN \(\?,\?\)\)/);
  const b = buildFilterSql({ mailboxNames: ["Bozze"] });
  assert.match(b.clause, /m\.mailbox IN \(\?\)/);
});
