import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";

test("enableVectors loads sqlite-vec and a vec table can be created", () => {
  const s = Store.open(":memory:");
  assert.equal(s.enableVectors(), true);
  s.ensureVecTable(4);
  // idempotent
  s.ensureVecTable(4);
  const v = s.raw.prepare("select vec_version() as v").get() as { v: string };
  assert.match(v.v, /^v?\d/);
  // embed_state table exists
  s.raw.prepare("INSERT INTO embed_state(message_id, model, dim, source_hash, embedded_at) VALUES ('m1','mod',4,'h',1)").run();
  const row = s.raw.prepare("SELECT model FROM embed_state WHERE message_id='m1'").get() as { model: string };
  assert.equal(row.model, "mod");
  s.close();
});
