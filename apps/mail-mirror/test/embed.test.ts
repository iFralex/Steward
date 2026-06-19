import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../src/store.ts";
import { embedMessage, sourceHash, sourceTextFor, type EmbedDeps } from "../src/embed.ts";

function row(id: string, subject: string, body = "body"): MessageRow {
  return {
    messageId: id, account: "ACC", mailbox: "INBOX", fromName: "", fromAddr: "a@x",
    to: [], cc: [], subject, date: 1750000000, bodyText: body, bodyState: "full",
    source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
  };
}

function deps(store: Store, embed: (t: string) => Promise<number[] | null>): EmbedDeps {
  return { store, embed, model: "mod" };
}

test("embedMessage embeds, then skips unchanged, re-embeds on change, no-ops when down", async () => {
  const s = Store.open(":memory:");
  s.enableVectors();
  s.upsertMessage(row("a@x", "trains"));
  const d = deps(s, async () => [1, 0, 0, 0]);

  assert.equal(await embedMessage(d, "a@x"), "embedded");
  assert.equal(s.embeddedCount(), 1);
  assert.equal(await embedMessage(d, "a@x"), "skipped"); // unchanged source hash

  // change the body -> needs re-embed
  s.upsertMessage(row("a@x", "trains", "now about cooking"));
  assert.equal(await embedMessage(d, "a@x"), "embedded");

  // endpoint down -> unavailable, no state written
  s.upsertMessage(row("b@x", "new"));
  const down = deps(s, async () => null);
  assert.equal(await embedMessage(down, "b@x"), "unavailable");
  assert.equal(s.embedStateFor("b@x"), undefined);

  assert.equal(await embedMessage(d, "missing@x"), "missing");
  s.close();
});

test("sourceTextFor joins subject+body; sourceHash is stable", () => {
  assert.equal(sourceTextFor(row("a", "S", "B")), "S\nB");
  assert.equal(sourceHash("x"), sourceHash("x"));
  assert.notEqual(sourceHash("x"), sourceHash("y"));
});
