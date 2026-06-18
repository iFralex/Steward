import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadIndex, normalizeSubject } from "../src/threads.ts";

test("union-find groups messages sharing references, merging via a bridge", () => {
  const ti = new ThreadIndex();
  ti.union(["a"]);            // lone message a
  ti.union(["b", "c"]);       // c references b
  ti.union(["d", "b"]);       // d references b -> {b,c,d}
  ti.union(["e", "a", "c"]);  // e bridges a and c -> everything except none
  const root = ti.rootOf("a");
  for (const id of ["a", "b", "c", "d", "e"]) assert.equal(ti.rootOf(id), root);
});

test("normalizeSubject strips reply/forward prefixes repeatedly", () => {
  assert.equal(normalizeSubject("Re: Fwd:  R: Offerta"), "Offerta");
  assert.equal(normalizeSubject("I: Protiviti"), "Protiviti");
  assert.equal(normalizeSubject("Plain"), "Plain");
});
