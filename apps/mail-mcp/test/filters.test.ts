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
