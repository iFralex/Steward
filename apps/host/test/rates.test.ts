import { test } from "node:test";
import assert from "node:assert/strict";
import { costByKindFromTiers } from "../src/server.ts";

const flash = { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 };
const pro = { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435 };

test("costByKindFromTiers multiplies each tier's tokens by its own rates and sums in USD", () => {
  const byTier = [
    { tier: "tier-5", input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0 },
    { tier: "tier-6", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
  ];
  const out = costByKindFromTiers(byTier, { "tier-5": flash, "tier-6": pro }, flash);
  assert.ok(Math.abs(out.input - (0.14 + 0.435)) < 1e-9);
  assert.ok(Math.abs(out.output - 0.14) < 1e-9);
  assert.ok(Math.abs(out.cacheRead - 0.0056) < 1e-9);
  assert.equal(out.cacheWrite, 0);
});

test("costByKindFromTiers falls back to the flat config cost for unknown tiers or a missing map", () => {
  const byTier = [{ tier: "tier-9", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }];
  assert.ok(Math.abs(costByKindFromTiers(byTier, {}, flash).input - 0.14) < 1e-9);
  assert.ok(Math.abs(costByKindFromTiers(byTier, null, flash).input - 0.14) < 1e-9);
});

test("local-embed tokens price at zero when the gateway rates map carries a zero entry for it", () => {
  const zeroEmbed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const byTier = [{ tier: "local-embed", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }];
  const out = costByKindFromTiers(byTier, { "local-embed": zeroEmbed }, flash);
  assert.equal(out.input, 0);
  assert.equal(out.output, 0);
  assert.equal(out.cacheRead, 0);
  assert.equal(out.cacheWrite, 0);
});
