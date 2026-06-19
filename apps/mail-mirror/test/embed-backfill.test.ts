import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";
import { embedBackfill, type EmbedDeps } from "../src/embed.ts";

function row(id: string, date: number): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], subject: "s" + id, date, bodyText: "b", bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
    toNames: [], ccNames: [], unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null,
  };
}

test("embedBackfill embeds all needing, recent-first; stops when unavailable", async () => {
  const s = Store.open(":memory:");
  s.enableVectors(); s.ensureVecTable(2);
  s.upsertMessage(row("old@x", 1000));
  s.upsertMessage(row("new@x", 2000));
  const deps: EmbedDeps = { store: s, model: "mod", embed: async () => { return [1, 0]; } };
  const res = await embedBackfill(deps, { limit: 10 });
  assert.equal(res.embedded, 2);
  assert.equal(res.unavailable, false);
  assert.equal(s.embeddedCount(), 2);

  // now an unavailable endpoint on a fresh message -> stops, reports unavailable
  s.upsertMessage(row("z@x", 3000));
  const down: EmbedDeps = { store: s, model: "mod", embed: async () => null };
  const r2 = await embedBackfill(down, { limit: 10 });
  assert.equal(r2.embedded, 0);
  assert.equal(r2.unavailable, true);
  s.close();
});
