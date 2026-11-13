import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { UsageLedger } from "../src/index.ts";
import { aggregateLlm } from "../src/aggregate.ts";

test("streaming aggregates match SQL across services, null groups, day boundaries and cutoffs", () => {
  const ledger = new UsageLedger(new Database(":memory:"));
  try {
    const insert = ledger.raw.prepare(`INSERT INTO llm_calls(ts,service,action,model,tier,input_tokens,
      output_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const origin = new Date(2026, 9, 24, 23, 59, 30).getTime();
    for (let i = 0; i < 300; i++) insert.run(origin + i * 600_000, `s${i % 3}`, `a${i % 5}`,
      i % 4 ? `m${i % 2}` : null, i % 7 ? "tier-5" : null, i, i % 9, i % 11, i % 4, i % 13 / 100);
    for (const cutoff of [0, origin + 125 * 600_000, origin + 1e12]) {
      const dayCutoff = Math.max(cutoff, origin + 50 * 600_000);
      const got = aggregateLlm(ledger.raw, cutoff, dayCutoff);
      const tok = "input_tokens+output_tokens+cache_read_tokens+cache_write_tokens";
      const expected = {
        totals: ledger.raw.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost,
          COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
          COALESCE(SUM(cache_read_tokens),0) cacheRead, COALESCE(SUM(cache_write_tokens),0) cacheWrite FROM llm_calls WHERE ts>=?`).get(cutoff),
        byService: ledger.raw.prepare(`SELECT service,SUM(cost_usd) cost,COUNT(*) calls,SUM(${tok}) tokens FROM llm_calls WHERE ts>=? GROUP BY service`).all(cutoff),
        byAction: ledger.raw.prepare(`SELECT service,action,SUM(cost_usd) cost,COUNT(*) calls,SUM(${tok}) tokens,AVG(cost_usd) avgCost FROM llm_calls WHERE ts>=? GROUP BY service,action`).all(cutoff),
        byModel: ledger.raw.prepare(`SELECT model,SUM(cost_usd) cost,COUNT(*) calls,SUM(${tok}) tokens FROM llm_calls WHERE ts>=? GROUP BY model`).all(cutoff),
        byTier: ledger.raw.prepare(`SELECT tier,SUM(input_tokens) input,SUM(output_tokens) output,SUM(cache_read_tokens) cacheRead,SUM(cache_write_tokens) cacheWrite FROM llm_calls WHERE ts>=? GROUP BY tier`).all(cutoff),
        byDay: ledger.raw.prepare(`SELECT strftime('%Y-%m-%d',ts/1000,'unixepoch','localtime') day,service,SUM(cost_usd) cost,COUNT(*) calls,SUM(${tok}) tokens FROM llm_calls WHERE ts>=? GROUP BY day,service`).all(dayCutoff),
      };
      // SQL may add floating point costs in a different order. Normalize only
      // those sub-nanodollar differences and group order, preserving all values.
      const normalize = (v: unknown): unknown => {
        if (typeof v === "number") return Math.round(v * 1e9) / 1e9;
        if (Array.isArray(v)) return v.map(normalize).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort().map(([k,x]) => [k, normalize(x)]));
        return v;
      };
      assert.deepEqual(normalize(got), normalize(expected));
    }
  } finally { ledger.raw.close(); }
});
