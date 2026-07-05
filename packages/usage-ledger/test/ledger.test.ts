import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { UsageLedger, type LlmCallRecord } from "../src/index.ts";

function openTemp(): UsageLedger {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  return new UsageLedger(new Database(join(dir, "usage.db")));
}

function call(over: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    ts: Date.now(), service: "mail-promoter", action: "triage", sessionId: null,
    tier: "tier-5", model: "deepseek-v4-flash",
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0,
    costUsd: 0.001, durationMs: 500, ok: true, status: 200,
    ...over,
  };
}

test("records llm calls and aggregates totals, byService, byAction with avgCost", () => {
  const ledger = openTemp();
  ledger.recordLlmCall(call());
  ledger.recordLlmCall(call({ action: "triage", costUsd: 0.003 }));
  ledger.recordLlmCall(call({ service: "host", action: "agent-turn", costUsd: 0.01 }));

  const s = ledger.summary();
  assert.equal(s.totals.calls, 3);
  assert.ok(Math.abs(s.totals.cost - 0.014) < 1e-9);
  assert.equal(s.totals.input, 300);
  assert.equal(s.totals.cacheRead, 120);

  assert.equal(s.byService[0].service, "host"); // sorted by cost desc
  assert.equal(s.byService[1].service, "mail-promoter");
  assert.ok(Math.abs(s.byService[1].cost - 0.004) < 1e-9);

  const triage = s.byAction.find((a) => a.service === "mail-promoter" && a.action === "triage");
  assert.ok(triage);
  assert.equal(triage.calls, 2);
  assert.ok(Math.abs(triage.avgCost - 0.002) < 1e-9);
});

test("summary(days) filters by period; byDay splits by service", () => {
  const ledger = openTemp();
  const old = Date.now() - 10 * 86_400_000;
  ledger.recordLlmCall(call({ ts: old, costUsd: 5 }));
  ledger.recordLlmCall(call({ costUsd: 0.5 }));
  ledger.recordLlmCall(call({ service: "host", action: "agent-turn", costUsd: 0.25 }));

  const week = ledger.summary(7);
  assert.equal(week.totals.calls, 2);
  assert.ok(Math.abs(week.totals.cost - 0.75) < 1e-9);
  // today has two rows, one per service
  const today = week.byDay.filter((d) => d.day === new Date().toISOString().slice(0, 10));
  assert.equal(today.length, 2);

  const all = ledger.summary();
  assert.equal(all.totals.calls, 3);
});

test("failed calls and recent rows are exposed; tool calls aggregate as before", () => {
  const ledger = openTemp();
  ledger.recordLlmCall(call({ ok: false, status: 400, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }));
  ledger.recordTool({ ts: Date.now(), sessionId: "c1", tool: "read_message", durationMs: 120, ok: true });
  ledger.recordTool({ ts: Date.now(), sessionId: "c1", tool: "read_message", durationMs: 80, ok: false });

  const s = ledger.summary();
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].ok, 0);
  assert.equal(s.byTool[0].tool, "read_message");
  assert.equal(s.byTool[0].calls, 2);
  assert.equal(s.byTool[0].errors, 1);
  assert.equal(s.toolTotals.calls, 2);
});
