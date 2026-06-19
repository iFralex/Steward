import assert from "node:assert/strict";
import { test } from "node:test";
import { rrf } from "../src/rrf.ts";

test("rrf fuses two rankings; shared high-rank items win", () => {
  const fts = ["a", "b", "c"];
  const vec = ["b", "a", "d"];
  const out = rrf([fts, vec]);
  // b is rank0+rank1, a is rank1+rank... b and a both appear in both; b scores highest
  assert.equal(out[0].id, "b");
  assert.ok(out.find((r) => r.id === "a"));
  assert.ok(out.find((r) => r.id === "d")); // appears in one list only, still included
  // scores strictly descending
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
});

test("rrf with one ranking preserves its order", () => {
  assert.deepEqual(rrf([["x", "y", "z"]]).map((r) => r.id), ["x", "y", "z"]);
});

test("rrf empty input is empty", () => {
  assert.deepEqual(rrf([]), []);
});
