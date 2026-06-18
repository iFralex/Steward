import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";
import { fillBody } from "../src/applescript-fallback.ts";

const US = "\x1f";

function partialRow(): MessageRow {
  return {
    messageId: "p1@x", account: "ACC", mailbox: "INBOX",
    fromName: "A", fromAddr: "a@x", to: ["me@x"], cc: [],
    subject: "Subj", date: 1750000000, bodyText: "", bodyState: "none",
    source: "emlx", emlxPath: "/p/1.partial.emlx", inReplyTo: null,
    references: [], gmThrid: null, size: 0,
  };
}

test("fillBody pulls the body via the (stub) AppleScript runner and marks full", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(partialRow());
  // mail-mcp parseDetail expects: subject US sender US date US body
  const fakeOut = ["Subj", "A <a@x>", "2026", "DOWNLOADED BODY TEXT"].join(US);
  const ok = await fillBody(s, "p1@x", async () => fakeOut);
  assert.equal(ok, true);
  const got = s.getMessage("p1@x")!;
  assert.equal(got.bodyState, "full");
  assert.equal(got.source, "applescript");
  assert.ok(got.bodyText.includes("DOWNLOADED BODY TEXT"));
  s.close();
});
