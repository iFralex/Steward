import type Database from "better-sqlite3";
import type { LedgerSummary } from "./index.js";

/** Aggregate the history in one pass without disk-backed GROUP BY sorts. */
export function aggregateLlm(raw: Database.Database, cutoff: number, dayCutoff: number) {
  const totals = { calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const services = new Map<string, LedgerSummary["byService"][number]>();
  const actions = new Map<string, LedgerSummary["byAction"][number]>();
  const days = new Map<string, LedgerSummary["byDay"][number]>();
  const models = new Map<string, LedgerSummary["byModel"][number]>();
  const tiers = new Map<string, LedgerSummary["byTier"][number]>();
  let minute = NaN, day = "";
  const rows = raw.prepare(`SELECT ts, service, action, model, tier, input_tokens,
    output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
    FROM llm_calls WHERE ts >= ? ORDER BY ts`).raw(true).iterate(cutoff);
  for (const row of rows) {
    const [ts, service, action, model, tier, input, output, cacheRead, cacheWrite, cost] = row as
      [number, string, string, string, string, number, number, number, number, number];
    const tokens = input + output + cacheRead + cacheWrite;
    totals.calls++; totals.cost += cost; totals.input += input; totals.output += output;
    totals.cacheRead += cacheRead; totals.cacheWrite += cacheWrite;
    let s = services.get(service);
    if (!s) services.set(service, s = { service, cost: 0, calls: 0, tokens: 0 });
    s.cost += cost; s.calls++; s.tokens += tokens;
    const actionKey = JSON.stringify([service, action]);
    let a = actions.get(actionKey);
    if (!a) actions.set(actionKey, a = { service, action, cost: 0, calls: 0, tokens: 0, avgCost: 0 });
    a.cost += cost; a.calls++; a.tokens += tokens;
    let m = models.get(model);
    if (!m) models.set(model, m = { model, cost: 0, calls: 0, tokens: 0 });
    m.cost += cost; m.calls++; m.tokens += tokens;
    let t = tiers.get(tier);
    if (!t) tiers.set(tier, t = { tier, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    t.input += input; t.output += output; t.cacheRead += cacheRead; t.cacheWrite += cacheWrite;
    if (ts >= dayCutoff) {
      const nextMinute = Math.floor(ts / 60_000);
      if (minute !== nextMinute) {
        minute = nextMinute;
        const date = new Date(ts);
        day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      }
      const key = JSON.stringify([day, service]);
      let d = days.get(key);
      if (!d) days.set(key, d = { day, service, cost: 0, calls: 0, tokens: 0 });
      d.cost += cost; d.calls++; d.tokens += tokens;
    }
  }
  for (const a of actions.values()) a.avgCost = a.cost / a.calls;
  const byCost = (a: { cost: number }, b: { cost: number }) => b.cost - a.cost;
  return { totals, byService: [...services.values()].sort(byCost),
    byAction: [...actions.values()].sort(byCost), byModel: [...models.values()].sort(byCost),
    byTier: [...tiers.values()], byDay: [...days.values()].sort((a,b) => b.day.localeCompare(a.day)) };
}
