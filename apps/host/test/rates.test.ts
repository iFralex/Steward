import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTierRates } from "../src/server.ts";

const FALLBACK = { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 };
const MAP = {
  "tier-1": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "tier-5": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  "tier-6": { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435 },
};

test("pickTierRates returns the FLAT rate for the active tier (not the per-tier map)", () => {
  const flat = pickTierRates(MAP, "tier-6", FALLBACK) as Record<string, number>;
  // must be flat: the Usage page reads rates.input directly
  assert.equal(flat.input, 0.435);
  assert.equal(flat.output, 0.87);
  assert.equal(typeof (flat as { "tier-6"?: unknown })["tier-6"], "undefined");
});

test("pickTierRates falls back to the flat config cost when the tier or map is absent", () => {
  assert.equal(pickTierRates(MAP, "tier-99", FALLBACK), FALLBACK);
  assert.equal(pickTierRates(undefined, "tier-5", FALLBACK), FALLBACK);
  assert.equal(pickTierRates(null, "tier-5", FALLBACK), FALLBACK);
  assert.equal(pickTierRates("garbage", "tier-5", FALLBACK), FALLBACK);
});
