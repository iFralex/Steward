import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanLabel } from "../src/labels.ts";

test("cleanLabel strips Apple label decoration", () => {
  assert.equal(cleanLabel("_$!<Home>!$_"), "Home");
  assert.equal(cleanLabel("_$!<Work>!$_"), "Work");
});

test("cleanLabel passes through plain labels and null", () => {
  assert.equal(cleanLabel("Gmail"), "Gmail");
  assert.equal(cleanLabel(null), null);
  assert.equal(cleanLabel(""), null);
});
