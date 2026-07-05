# Usage Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every LLM call in the system is metered by the gateway into a shared SQLite ledger (`llm_calls`) with service/action/session attribution, and the Usage page shows per-service, per-action, per-call and total costs.

**Architecture:** The gateway (the choke point all LLM traffic already flows through) writes one ledger row per `/v1/chat/completions` and `/v1/embeddings` call. Callers attribute themselves with `x-usage-service` / `x-usage-action` headers; missing headers record as `unknown`. The host stops writing the legacy `turns` table (double counting), keeps writing `tool_calls`, and serves aggregations via `/usage?days=`. The web Usage page is redesigned around per-service/per-action views.

**Tech Stack:** Node 22+, TypeScript via tsx, better-sqlite3 (WAL), node:test + node:assert, React + shadcn + hand-rolled SVG (no charting deps).

**Spec:** `docs/superpowers/specs/2026-07-05-usage-metering-design.md`

## Global Constraints

- Ledger DB path: `USAGE_DIR` env, else `~/Library/Application Support/steward-usage/usage.db` (must match the host's existing path exactly).
- Metering must NEVER break an LLM call: every ledger write wrapped in try/catch with `console.warn`, never rethrow.
- Attribution header names (exact): `x-usage-service`, `x-usage-action`, `x-usage-session`. Fallback value: `unknown`.
- The legacy `turns` table is no longer written NOR read (history reset by user decision). Do not drop the table.
- No new charting/library dependencies in `apps/web`.
- The llm-wiki app must never send usage headers to non-gateway endpoints. Gateway detection = URL origin ∈ {`http://127.0.0.1:4000`, `http://localhost:4000`}.
- All new tests use `node:test` + `node:assert/strict`, run with `node --import tsx --test` (repo convention).
- Run `npm run typecheck --workspace=<pkg>` in every touched workspace before committing.

---

### Task 1: `@steward/usage-ledger` shared package

The SQLite ledger both processes share: gateway writes `llm_calls`, host writes `tool_calls` and reads aggregations.

**Files:**
- Create: `packages/usage-ledger/package.json`
- Create: `packages/usage-ledger/tsconfig.json` (copy of `packages/search/tsconfig.json`)
- Create: `packages/usage-ledger/src/index.ts`
- Test: `packages/usage-ledger/test/ledger.test.ts`

**Interfaces:**
- Consumes: nothing (leaf package).
- Produces (used by Tasks 3–5):
  - `interface LlmCallRecord { ts: number; service: string; action: string; sessionId?: string | null; tier: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; durationMs: number; ok: boolean; status: number }`
  - `interface ToolCallRecord { ts: number; sessionId: string; tool: string; durationMs: number; ok: boolean }`
  - `class UsageLedger { static open(): UsageLedger; constructor(db: Database); readonly raw: Database; recordLlmCall(r: LlmCallRecord): void; recordTool(t: ToolCallRecord): void; summary(days?: number): LedgerSummary }`
  - `function usageLedger(): UsageLedger` (process singleton)
  - `interface LedgerSummary { totals: { calls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }; byService: { service: string; cost: number; calls: number; tokens: number }[]; byAction: { service: string; action: string; calls: number; cost: number; tokens: number; avgCost: number }[]; byDay: { day: string; service: string; cost: number; calls: number; tokens: number }[]; byModel: { model: string; cost: number; tokens: number; calls: number }[]; byTier: { tier: string; input: number; output: number; cacheRead: number; cacheWrite: number }[]; recent: { ts: number; service: string; action: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; durationMs: number; ok: number }[]; byTool: { tool: string; calls: number; errors: number; totalMs: number; avgMs: number; maxMs: number }[]; toolTotals: { calls: number; errors: number; totalMs: number } }`

- [ ] **Step 1: Scaffold the package**

`packages/usage-ledger/package.json`:

```json
{
  "name": "@steward/usage-ledger",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

Copy the tsconfig: `cp packages/search/tsconfig.json packages/usage-ledger/tsconfig.json`

The root `package.json` workspaces already include `packages/*` — no root change. Run `npm install` once after creating the package so the workspace links.

- [ ] **Step 2: Write the failing test**

`packages/usage-ledger/test/ledger.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test --workspace=@steward/usage-ledger`
Expected: FAIL — cannot find module `../src/index.ts`.

- [ ] **Step 4: Implement the ledger**

`packages/usage-ledger/src/index.ts`:

```ts
/**
 * Shared persistent LLM usage ledger (SQLite). The gateway writes one row per
 * LLM call (llm_calls); the host writes tool invocations (tool_calls) and
 * reads the aggregations the Usage page shows. Two processes share the file:
 * WAL + busy_timeout. The legacy `turns` table (pre-metering per-turn ledger)
 * is intentionally neither created, written, nor read — history was reset.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LlmCallRecord {
  ts: number;
  service: string;
  action: string;
  sessionId?: string | null;
  tier: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  ok: boolean;
  status: number;
}

export interface ToolCallRecord {
  ts: number;
  sessionId: string;
  tool: string;
  durationMs: number;
  ok: boolean;
}

export interface LedgerSummary {
  totals: { calls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number };
  byService: { service: string; cost: number; calls: number; tokens: number }[];
  byAction: { service: string; action: string; calls: number; cost: number; tokens: number; avgCost: number }[];
  byDay: { day: string; service: string; cost: number; calls: number; tokens: number }[];
  byModel: { model: string; cost: number; tokens: number; calls: number }[];
  byTier: { tier: string; input: number; output: number; cacheRead: number; cacheWrite: number }[];
  recent: {
    ts: number; service: string; action: string; model: string;
    input: number; output: number; cacheRead: number; cacheWrite: number;
    cost: number; durationMs: number; ok: number;
  }[];
  byTool: { tool: string; calls: number; errors: number; totalMs: number; avgMs: number; maxMs: number }[];
  toolTotals: { calls: number; errors: number; totalMs: number };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  service TEXT NOT NULL DEFAULT 'unknown',
  action TEXT NOT NULL DEFAULT 'unknown',
  session_id TEXT,
  tier TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  status INTEGER NOT NULL DEFAULT 200
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls(ts);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT,
  tool TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(ts);
`;

const TOKENS = "input_tokens + output_tokens + cache_read_tokens + cache_write_tokens";

/** Same one-shot directory migration the host uses (duplicated: packages cannot import app code). */
function migrateLegacyPath(legacyPath: string, currentPath: string): void {
  try {
    if (existsSync(legacyPath) && !existsSync(currentPath)) renameSync(legacyPath, currentPath);
  } catch { /* best-effort */ }
}

export class UsageLedger {
  readonly raw: Database.Database;

  constructor(db: Database.Database) {
    this.raw = db;
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("busy_timeout = 2000");
    this.raw.exec(SCHEMA);
  }

  static open(): UsageLedger {
    const dir = process.env.USAGE_DIR ?? join(homedir(), "Library", "Application Support", "steward-usage");
    if (!process.env.USAGE_DIR) {
      migrateLegacyPath(join(homedir(), "Library", "Application Support", "llmwiki-usage"), dir);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new UsageLedger(new Database(join(dir, "usage.db")));
  }

  recordLlmCall(r: LlmCallRecord): void {
    this.raw.prepare(
      `INSERT INTO llm_calls (ts, service, action, session_id, tier, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, duration_ms, ok, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.ts, r.service, r.action, r.sessionId ?? null, r.tier, r.model,
      r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens,
      r.costUsd, r.durationMs, r.ok ? 1 : 0, r.status,
    );
  }

  recordTool(t: ToolCallRecord): void {
    this.raw.prepare(
      `INSERT INTO tool_calls (ts, session_id, tool, duration_ms, ok) VALUES (?, ?, ?, ?, ?)`,
    ).run(t.ts, t.sessionId, t.tool, t.durationMs, t.ok ? 1 : 0);
  }

  /** Aggregations for the Usage page. `days` = lookback window; undefined = all time. */
  summary(days?: number): LedgerSummary {
    const cutoff = days ? Date.now() - days * 86_400_000 : 0;
    // byDay is a chart: cap "all time" at the last 90 days so it stays renderable.
    const dayCutoff = Math.max(cutoff, Date.now() - 90 * 86_400_000);

    const totals = this.raw.prepare(
      `SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost,
              COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
              COALESCE(SUM(cache_read_tokens),0) cacheRead, COALESCE(SUM(cache_write_tokens),0) cacheWrite
       FROM llm_calls WHERE ts >= ?`,
    ).get(cutoff) as LedgerSummary["totals"];
    const byService = this.raw.prepare(
      `SELECT service, SUM(cost_usd) cost, COUNT(*) calls, SUM(${TOKENS}) tokens
       FROM llm_calls WHERE ts >= ? GROUP BY service ORDER BY cost DESC`,
    ).all(cutoff) as LedgerSummary["byService"];
    const byAction = this.raw.prepare(
      `SELECT service, action, COUNT(*) calls, SUM(cost_usd) cost, SUM(${TOKENS}) tokens,
              AVG(cost_usd) avgCost
       FROM llm_calls WHERE ts >= ? GROUP BY service, action ORDER BY cost DESC`,
    ).all(cutoff) as LedgerSummary["byAction"];
    const byDay = this.raw.prepare(
      // ts is milliseconds (JS Date.now); strftime wants seconds.
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') day, service,
              SUM(cost_usd) cost, COUNT(*) calls, SUM(${TOKENS}) tokens
       FROM llm_calls WHERE ts >= ? GROUP BY day, service ORDER BY day DESC`,
    ).all(dayCutoff) as LedgerSummary["byDay"];
    const byModel = this.raw.prepare(
      `SELECT model, SUM(cost_usd) cost, SUM(${TOKENS}) tokens, COUNT(*) calls
       FROM llm_calls WHERE ts >= ? GROUP BY model ORDER BY cost DESC`,
    ).all(cutoff) as LedgerSummary["byModel"];
    const byTier = this.raw.prepare(
      `SELECT tier, SUM(input_tokens) input, SUM(output_tokens) output,
              SUM(cache_read_tokens) cacheRead, SUM(cache_write_tokens) cacheWrite
       FROM llm_calls WHERE ts >= ? GROUP BY tier`,
    ).all(cutoff) as LedgerSummary["byTier"];
    const recent = this.raw.prepare(
      `SELECT ts, service, action, model, input_tokens input, output_tokens output,
              cache_read_tokens cacheRead, cache_write_tokens cacheWrite,
              cost_usd cost, duration_ms durationMs, ok
       FROM llm_calls WHERE ts >= ? ORDER BY ts DESC LIMIT 100`,
    ).all(cutoff) as LedgerSummary["recent"];
    const byTool = this.raw.prepare(
      `SELECT tool, COUNT(*) calls,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) errors,
              SUM(duration_ms) totalMs, AVG(duration_ms) avgMs, MAX(duration_ms) maxMs
       FROM tool_calls WHERE ts >= ? GROUP BY tool ORDER BY calls DESC`,
    ).all(cutoff) as LedgerSummary["byTool"];
    const toolTotals = this.raw.prepare(
      `SELECT COUNT(*) calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) errors, COALESCE(SUM(duration_ms),0) totalMs
       FROM tool_calls WHERE ts >= ?`,
    ).get(cutoff) as LedgerSummary["toolTotals"];

    return { totals, byService, byAction, byDay, byModel, byTier, recent, byTool, toolTotals };
  }
}

let singleton: UsageLedger | undefined;
export function usageLedger(): UsageLedger {
  return (singleton ??= UsageLedger.open());
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm install && npm test --workspace=@steward/usage-ledger && npm run typecheck --workspace=@steward/usage-ledger`
Expected: all 3 tests PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/usage-ledger package-lock.json
git commit -m "feat(usage-ledger): shared SQLite ledger package (llm_calls + tool_calls)"
```

---

### Task 2: attribution constants in `@steward/protocol`

**Files:**
- Modify: `packages/protocol/src/index.ts` (append at end of file)
- Test: `packages/protocol/test/usage-headers.test.ts` (create; check `packages/protocol/package.json` has a test script first — if the package has no test script, add the repo-standard one: `"test": "node --import tsx --test \"test/**/*.test.ts\""` plus `tsx` devDependency)

**Interfaces:**
- Produces (used by Tasks 3, 5, 6, 7):
  - `const USAGE_SERVICE_HEADER = "x-usage-service"`, `USAGE_ACTION_HEADER = "x-usage-action"`, `USAGE_SESSION_HEADER = "x-usage-session"`, `USAGE_UNKNOWN = "unknown"`
  - `function usageHeaders(service: string, action: string, sessionId?: string): Record<string, string>`

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/usage-headers.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { usageHeaders, USAGE_SERVICE_HEADER, USAGE_ACTION_HEADER, USAGE_SESSION_HEADER } from "../src/index.ts";

test("usageHeaders builds the attribution headers, session optional", () => {
  assert.deepEqual(usageHeaders("mail-promoter", "triage"), {
    "x-usage-service": "mail-promoter",
    "x-usage-action": "triage",
  });
  assert.deepEqual(usageHeaders("host", "agent-turn", "chat-1"), {
    "x-usage-service": "host",
    "x-usage-action": "agent-turn",
    "x-usage-session": "chat-1",
  });
  assert.equal(USAGE_SERVICE_HEADER, "x-usage-service");
  assert.equal(USAGE_ACTION_HEADER, "x-usage-action");
  assert.equal(USAGE_SESSION_HEADER, "x-usage-session");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=@steward/protocol`
Expected: FAIL — `usageHeaders` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/protocol/src/index.ts`:

```ts
// ── LLM usage metering (gateway ledger attribution) ─────────────────────────
// Callers of the LLM gateway attribute themselves with these headers; the
// gateway records them in the shared usage ledger. Missing headers are
// recorded as USAGE_UNKNOWN so unlabeled spend stays visible.
export const USAGE_SERVICE_HEADER = "x-usage-service";
export const USAGE_ACTION_HEADER = "x-usage-action";
export const USAGE_SESSION_HEADER = "x-usage-session";
export const USAGE_UNKNOWN = "unknown";

export function usageHeaders(service: string, action: string, sessionId?: string): Record<string, string> {
  return {
    [USAGE_SERVICE_HEADER]: service,
    [USAGE_ACTION_HEADER]: action,
    ...(sessionId ? { [USAGE_SESSION_HEADER]: sessionId } : {}),
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test --workspace=@steward/protocol && npm run typecheck --workspace=@steward/protocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): usage attribution header constants + usageHeaders()"
```

---

### Task 3: gateway metering — non-streaming chat + embeddings + failures

**Files:**
- Modify: `apps/llm-gateway/package.json` (add deps)
- Modify: `apps/llm-gateway/src/gateway.ts`
- Modify: `apps/llm-gateway/test/config-shape.test.ts` (attemptsFor return shape changed)
- Test: `apps/llm-gateway/test/metering.test.ts` (create)

**Interfaces:**
- Consumes: `usageLedger()`, `LlmCallRecord` from `@steward/usage-ledger`; header constants from `@steward/protocol`.
- Produces (used by Task 4):
  - `attemptsFor(model): { name: string; target: GatewayModel }[]` (CHANGED signature — was `GatewayModel[]`)
  - `interface CallMeta { service: string; action: string; sessionId: string | null; t0: number; tierRequested: string }`
  - `function callMeta(req: IncomingMessage, body: Json): CallMeta`
  - `export function tokensFromUsage(usage: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number }`
  - `function recordCall(meta: CallMeta, servedTier: string | null, model: string, status: number, ok: boolean, usage: unknown): void`

- [ ] **Step 1: Add workspace deps**

In `apps/llm-gateway/package.json` `dependencies` add:

```json
"@steward/protocol": "*",
"@steward/usage-ledger": "*"
```

Run `npm install`.

- [ ] **Step 2: Write the failing tests**

`apps/llm-gateway/test/metering.test.ts` (follows the existing `gateway.test.ts` pattern: env first, dynamic import, mock provider):

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => { data += c.toString("utf8"); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as { port: number }).port);
  }));
}

// One shared temp ledger dir for the whole file (the ledger singleton caches it).
process.env.USAGE_DIR = mkdtempSync(join(tmpdir(), "gw-metering-"));

test("gateway metering: non-streaming chat, embeddings, unknown fallback, failures", async (t) => {
  const provider = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { model: string; input?: unknown };
    if (req.url?.endsWith("/embeddings")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }], model: body.model, usage: { prompt_tokens: 7, total_tokens: 7 } }));
      return;
    }
    if (typeof body.model === "string" && body.model.includes("pro")) {
      // used to simulate a deterministic 400 (no fallback)
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "cmpl-1", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 },
    }));
  });
  const providerPort = await listen(provider);
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  process.env.DEEPSEEK_API_KEY = "sk-test";
  // Route the local tiers at the same mock (tier-1/local-embed use customHost).
  const { startGateway, models } = await import("../src/gateway.ts");
  models["local-embed"].customHost = `http://127.0.0.1:${providerPort}`;
  const gw = startGateway(0);
  await new Promise((resolve) => gw.on("listening", resolve));
  const gwPort = (gw.address() as { port: number }).port;
  const { usageLedger } = await import("@steward/usage-ledger");
  t.after(() => { gw.close(); provider.close(); });

  // 1) labeled chat call → row with attribution + token split + cost
  const r1 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-usage-service": "mail-promoter",
      "x-usage-action": "triage",
      "x-usage-session": "run-1",
    },
    body: JSON.stringify({ model: "tier-5", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r1.status, 200);

  // 2) unlabeled call → unknown/unknown
  await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tier-5", messages: [{ role: "user", content: "hi" }] }),
  });

  // 3) embeddings call → volume row, cost 0 (no rates for local-embed)
  await fetch(`http://127.0.0.1:${gwPort}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "mail-mcp", "x-usage-action": "embed" },
    body: JSON.stringify({ model: "local-embed", input: "hello" }),
  });

  // 4) deterministic 4xx → failed row, tokens 0 (tier-6 = pro model → mock 400s)
  const r4 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "action-center", "x-usage-action": "scan" },
    body: JSON.stringify({ model: "tier-6", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r4.status, 400);

  const rows = usageLedger().raw.prepare(`SELECT * FROM llm_calls ORDER BY id`).all() as any[];
  assert.equal(rows.length, 4);

  assert.equal(rows[0].service, "mail-promoter");
  assert.equal(rows[0].action, "triage");
  assert.equal(rows[0].session_id, "run-1");
  assert.equal(rows[0].tier, "tier-5");
  assert.equal(rows[0].input_tokens, 60);      // prompt 100 - cacheRead 40
  assert.equal(rows[0].cache_read_tokens, 40);
  assert.equal(rows[0].output_tokens, 20);
  assert.equal(rows[0].ok, 1);
  // tier-5: (60*0.14 + 20*0.28 + 40*0.0028) / 1e6
  assert.ok(Math.abs(rows[0].cost_usd - 0.000014112) < 1e-12);

  assert.equal(rows[1].service, "unknown");
  assert.equal(rows[1].action, "unknown");

  assert.equal(rows[2].service, "mail-mcp");
  assert.equal(rows[2].input_tokens, 7);
  assert.equal(rows[2].cost_usd, 0);

  assert.equal(rows[3].service, "action-center");
  assert.equal(rows[3].ok, 0);
  assert.equal(rows[3].status, 400);
  assert.equal(rows[3].input_tokens, 0);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test --workspace=@steward/llm-gateway`
Expected: new test FAILS (0 rows in ledger / import errors); existing tests still pass.

- [ ] **Step 4: Implement in `gateway.ts`**

4a. Imports at top:

```ts
import { usageLedger } from "@steward/usage-ledger";
import { USAGE_ACTION_HEADER, USAGE_SERVICE_HEADER, USAGE_SESSION_HEADER, USAGE_UNKNOWN } from "@steward/protocol";
```

4b. Change `attemptsFor` (line ~83) to carry the tier NAME (needed for the rates lookup after fallback):

```ts
export function attemptsFor(model: string): { name: string; target: GatewayModel }[] {
  const names = fallbackOrder[model] ?? [model];
  return names.flatMap((name) => (models[name] ? [{ name, target: models[name] }] : []));
}
```

Update the two call sites in `proxyJson`/`proxyStream` from `for (const target of attempts)` to `for (const { name, target } of attempts)`.

4c. Add metering helpers (below `rates`):

```ts
interface CallMeta {
  service: string;
  action: string;
  sessionId: string | null;
  t0: number;
  tierRequested: string;
}

function callMeta(req: IncomingMessage, body: Json): CallMeta {
  const h = (name: string): string | null => {
    const v = req.headers[name];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return {
    service: h(USAGE_SERVICE_HEADER) ?? USAGE_UNKNOWN,
    action: h(USAGE_ACTION_HEADER) ?? USAGE_UNKNOWN,
    sessionId: h(USAGE_SESSION_HEADER),
    t0: Date.now(),
    tierRequested: typeof body.model === "string" ? body.model : "",
  };
}

/** Normalize an OpenAI-compatible usage block. DeepSeek reports cache hits as
 *  prompt_cache_hit_tokens; newer providers as prompt_tokens_details.cached_tokens.
 *  Embeddings responses have prompt_tokens only. */
export function tokensFromUsage(usage: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const u = usage as { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  const prompt = typeof u?.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
  return {
    input: Math.max(0, prompt - cacheRead),
    output: typeof u?.completion_tokens === "number" ? u.completion_tokens : 0,
    cacheRead,
    cacheWrite: 0,
  };
}

/** Best-effort ledger write — metering must never break an LLM call. */
function recordCall(meta: CallMeta, servedTier: string | null, model: string, status: number, ok: boolean, usage: unknown): void {
  try {
    const t = tokensFromUsage(usage);
    const r = servedTier ? rates[servedTier] : undefined;
    const cost = r ? (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + t.cacheWrite * r.cacheWrite) / 1_000_000 : 0;
    usageLedger().recordLlmCall({
      ts: Date.now(), service: meta.service, action: meta.action, sessionId: meta.sessionId,
      tier: servedTier ?? meta.tierRequested, model,
      inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite,
      costUsd: cost, durationMs: Date.now() - meta.t0, ok, status,
    });
  } catch (err) {
    console.warn(`[llm-gateway] usage ledger write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

4d. Thread `meta` through `proxyJson` and record at every terminal point. New signature `proxyJson(path: string, body: Json, res: ServerResponse, meta: CallMeta)`; inside the loop:

```ts
  for (const { name, target } of attempts) {
    const base = directOpenAIBaseUrl(target);
    if (!base) { lastText = `no route for provider ${target.provider}`; continue; }
    try {
      const upstream = await callProvider(base, path, body, target);
      const text = await upstream.text();
      if (upstream.ok) {
        let parsed: { usage?: unknown; model?: unknown } = {};
        try { parsed = JSON.parse(text) as typeof parsed; } catch { /* pass-through body untouched */ }
        recordCall(meta, name, typeof parsed.model === "string" ? parsed.model : target.model, upstream.status, true, parsed.usage ?? null);
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(text);
        return;
      }
      if (!shouldFallback(upstream.status)) {
        recordCall(meta, name, target.model, upstream.status, false, null);
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(text);
        return;
      }
      lastStatus = upstream.status;
      lastText = text;
    } catch (err) {
      lastStatus = 502;
      lastText = err instanceof Error ? err.message : String(err);
    }
  }

  recordCall(meta, null, "", lastStatus, false, null);
  json(res, lastStatus, { /* unchanged error body */ });
```

4e. In `handle()`, build the meta and pass it down (streaming wiring lands in Task 4 — for now pass meta to `proxyStream` too and just add the parameter there without recording):

```ts
    const body = JSON.parse(await readBody(req)) as Json;
    const meta = callMeta(req, body);
    const path = url.replace(/^\/v1/, "");
    if (body.stream === true) {
      await proxyStream(path, body, res, meta);
    } else {
      await proxyJson(path, body, res, meta);
    }
```

4f. Update `apps/llm-gateway/test/config-shape.test.ts` line 24 for the new shape:

```ts
  assert.deepEqual(attemptsFor("tier-5").map((a) => a.target.model), [
```

(keep the expected model list unchanged).

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test --workspace=@steward/llm-gateway && npm run typecheck --workspace=@steward/llm-gateway`
Expected: all PASS (including existing gateway.test.ts / adapter tests).

- [ ] **Step 6: Commit**

```bash
git add apps/llm-gateway package-lock.json
git commit -m "feat(gateway): meter non-streaming chat + embeddings into the shared usage ledger"
```

---

### Task 4: gateway metering — streaming

**Files:**
- Modify: `apps/llm-gateway/src/gateway.ts`
- Test: `apps/llm-gateway/test/metering-stream.test.ts` (create)

**Interfaces:**
- Consumes: `CallMeta`, `recordCall`, `tokensFromUsage` from Task 3.
- Produces: `pipeStreamingResponse(upstream, res): Promise<{ usage: unknown; model: string | null }>` (CHANGED — was `Promise<void>`).

- [ ] **Step 1: Write the failing tests**

`apps/llm-gateway/test/metering-stream.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => { data += c.toString("utf8"); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as { port: number }).port);
  }));
}
function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

process.env.USAGE_DIR = mkdtempSync(join(tmpdir(), "gw-stream-metering-"));

test("streaming chat records usage from the final SSE chunk; absent usage records tokens 0", async (t) => {
  let sendUsage = true;
  const requests: { stream_options?: unknown }[] = [];
  const provider = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { model: string; stream_options?: unknown };
    requests.push({ stream_options: body.stream_options });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks: unknown[] = [
      { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
      {
        id: "c1", object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        ...(sendUsage ? { usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 30 } } : {}),
      },
    ];
    res.end(sse(chunks));
  });
  const providerPort = await listen(provider);
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  process.env.DEEPSEEK_API_KEY = "sk-test";
  const { startGateway } = await import("../src/gateway.ts");
  const gw = startGateway(0);
  await new Promise((resolve) => gw.on("listening", resolve));
  const gwPort = (gw.address() as { port: number }).port;
  const { usageLedger } = await import("@steward/usage-ledger");
  t.after(() => { gw.close(); provider.close(); });

  const call = () => fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "host", "x-usage-action": "agent-turn" },
    body: JSON.stringify({ model: "tier-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

  const r1 = await call();
  await r1.text(); // drain the SSE stream
  sendUsage = false;
  const r2 = await call();
  await r2.text();

  // include_usage was injected toward DeepSeek
  assert.deepEqual(requests[0].stream_options, { include_usage: true });

  const rows = usageLedger().raw.prepare(`SELECT * FROM llm_calls ORDER BY id`).all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].service, "host");
  assert.equal(rows[0].input_tokens, 20);   // 50 - 30 cached
  assert.equal(rows[0].cache_read_tokens, 30);
  assert.equal(rows[0].output_tokens, 10);
  assert.equal(rows[0].ok, 1);
  // no usage chunk → tokens 0, call still counted
  assert.equal(rows[1].input_tokens, 0);
  assert.equal(rows[1].output_tokens, 0);
  assert.equal(rows[1].ok, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=@steward/llm-gateway`
Expected: new test FAILS (0 rows; no stream_options injected).

- [ ] **Step 3: Implement**

3a. In `prepareProviderBody`, inside the DeepSeek branch (after the early `if (target.provider !== "deepseek") return next;`), ask for the final usage block without changing what the client receives:

```ts
  if (next.stream === true && next.stream_options === undefined) {
    next.stream_options = { include_usage: true };
  }
```

3b. Rework `pipeStreamingResponse` to tee the bytes and parse the tail for the last `usage`/`model`:

```ts
async function pipeStreamingResponse(upstream: Response, res: ServerResponse): Promise<{ usage: unknown; model: string | null }> {
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    "cache-control": upstream.headers.get("cache-control") ?? "no-cache",
  });
  if (!upstream.body) {
    res.end();
    return { usage: null, model: null };
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  // Keep only the last 64KB of SSE text: the usage block arrives in the final
  // chunk, and capping the buffer keeps memory flat on long streams.
  let tail = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
    tail = (tail + decoder.decode(value, { stream: true })).slice(-65536);
  }
  res.end();

  let usage: unknown = null;
  let model: string | null = null;
  for (const line of tail.split("\n")) {
    if (!line.startsWith("data: ") || line.startsWith("data: [DONE]")) continue;
    try {
      const obj = JSON.parse(line.slice(6)) as { usage?: unknown; model?: unknown };
      if (obj.usage) usage = obj.usage;
      if (typeof obj.model === "string") model = obj.model;
    } catch { /* first line may be truncated by the 64KB cap */ }
  }
  return { usage, model };
}
```

3c. In `proxyStream` (signature already has `meta` from Task 4e of Task 3), record at each terminal point:

- native streaming success:
  ```ts
  if (upstream.ok) {
    const { usage, model } = await pipeStreamingResponse(upstream, res);
    recordCall(meta, name, model ?? target.model, 200, true, usage);
    return;
  }
  ```
- non-fallback error in the native branch: `recordCall(meta, name, target.model, upstream.status, false, null);` before `res.end(text)`.
- synthetic fallback success (branch 2, before `writeSyntheticSse(text, res)`):
  ```ts
  let parsed: { usage?: unknown; model?: unknown } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch { /* writeSyntheticSse re-parses and reports */ }
  recordCall(meta, name, typeof parsed.model === "string" ? parsed.model : target.model, 200, true, parsed.usage ?? null);
  writeSyntheticSse(text, res);
  return;
  ```
- non-fallback error in branch 2: `recordCall(meta, name, target.model, upstream.status, false, null);` before responding.
- exhausted attempts (after the loop): `recordCall(meta, null, "", lastStatus, false, null);`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test --workspace=@steward/llm-gateway && npm run typecheck --workspace=@steward/llm-gateway`
Expected: all PASS (existing streaming tests in gateway.test.ts must still pass — the client-visible stream is unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/llm-gateway
git commit -m "feat(gateway): meter streaming chat via stream_options.include_usage tail parsing"
```

---

### Task 5: host — attribution headers, stop writing `turns`, `/usage` rewrite

**Files:**
- Modify: `apps/host/package.json` (add `"@steward/usage-ledger": "*"` to dependencies; run `npm install`)
- Modify: `apps/host/src/core/pi-provider.ts`
- Modify: `apps/host/src/core/agent-runner.ts:19,236,302-308`
- Modify: `apps/host/src/server.ts:19,215-246,405-411`
- Delete: `apps/host/src/core/usage-store.ts`
- Modify: `apps/host/test/rates.test.ts`
- Test: `apps/host/test/usage-route.test.ts` (create)

**Interfaces:**
- Consumes: `usageLedger()` from `@steward/usage-ledger`; `usageHeaders` from `@steward/protocol`; `LedgerSummary.byTier`.
- Produces (used by Task 9's page):
  - `/usage?days=7|30|all` (default `30`) returning `{ ...LedgerSummary, costByKind: { input: number; output: number; cacheRead: number; cacheWrite: number } }`
  - `export function costByKindFromTiers(byTier: { tier: string; input: number; output: number; cacheRead: number; cacheWrite: number }[], ratesMap: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> | null, fallback: { input: number; output: number; cacheRead: number; cacheWrite: number }): { input: number; output: number; cacheRead: number; cacheWrite: number }` in `server.ts` (replaces `pickTierRates`)

- [ ] **Step 1: Write the failing tests**

Replace the `pickTierRates` test in `apps/host/test/rates.test.ts` with (keep the file's existing imports style):

```ts
import assert from "node:assert/strict";
import test from "node:test";
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
```

`apps/host/test/usage-route.test.ts` — pin the Pi attribution headers and the turns-write removal at the unit level:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerGatewayModel } from "../src/core/pi-provider.ts";

test("gateway provider registration carries usage attribution headers", () => {
  const { modelRegistry } = registerGatewayModel({
    baseUrl: "http://127.0.0.1:4000/v1", tier: "tier-5", apiKey: "x",
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  });
  const model = modelRegistry.find("gateway", "tier-5");
  assert.ok(model);
  const { headers } = modelRegistry.getAuthForModel(model);
  assert.equal(headers?.["x-usage-service"], "host");
  assert.equal(headers?.["x-usage-action"], "agent-turn");
});

test("agent-runner no longer writes the legacy turns ledger", () => {
  const src = readFileSync(new URL("../src/core/agent-runner.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("usageStore"), "agent-runner still references the removed usage-store");
  assert.ok(!src.includes(".record({"), "agent-runner still records turn rows");
});
```

Note for the implementer: if `getAuthForModel` does not exist on ModelRegistry, inspect `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts` for the method that returns "API key and request headers for a model" (its comment at line ~70) and use that method's real name in both the test and, if needed, the assertion shape. Do NOT skip the header assertion.

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace=@steward/host`
Expected: rates.test FAILS (`costByKindFromTiers` not exported), usage-route.test FAILS (no headers registered; usageStore still referenced).

- [ ] **Step 3: Implement — pi-provider headers**

In `apps/host/src/core/pi-provider.ts` add the import and pass headers (the registry sends them on every request to the gateway):

```ts
import { usageHeaders } from "@steward/protocol";
```

and inside `registerProvider("gateway", { ... })` add, next to `apiKey`:

```ts
    headers: usageHeaders("host", "agent-turn"),
```

(The Pi model registry is built once per connection, before any chat exists, so the per-chat `x-usage-session` header cannot be set here; `session_id` stays NULL for host rows. Grouping by chat remains available through the host's own `tool_calls.session_id` and the chat transcript.)

- [ ] **Step 4: Implement — agent-runner**

In `apps/host/src/core/agent-runner.ts`:
- Replace the import on line 19: `import { usageStore } from "./usage-store.ts";` → `import { usageLedger } from "@steward/usage-ledger";`
- Line 236: `usageStore().recordTool({...})` → `usageLedger().recordTool({...})` (same argument object).
- Delete the `try { usageStore().record({ ... }) } catch { /* ledger optional */ }` block (lines 302–308). Keep everything else in the `finally` — the `usage` emit that feeds the live chat footer still comes from Pi's `getSessionStats()`.

- [ ] **Step 5: Implement — server.ts `/usage` + costByKind; delete usage-store**

- Replace the import on line 19: `import { usageStore } from "./core/usage-store.ts";` → `import { usageLedger } from "@steward/usage-ledger";`
- Replace `pickTierRates` + `gatewayRates` (lines 215–246) with a full-map fetch and the kind-cost fold:

```ts
interface FlatRates { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * Attribute token-kind costs across tiers: each tier's tokens × that tier's
 * rates (USD per 1M), summed. Unknown tiers (e.g. local-embed) fall back to
 * the flat config cost so the split stays sane if the gateway map is stale.
 */
export function costByKindFromTiers(
  byTier: { tier: string; input: number; output: number; cacheRead: number; cacheWrite: number }[],
  ratesMap: Record<string, FlatRates> | null,
  fallback: FlatRates,
): FlatRates {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const t of byTier) {
    const r = ratesMap?.[t.tier] ?? fallback;
    out.input += (t.input * r.input) / 1_000_000;
    out.output += (t.output * r.output) / 1_000_000;
    out.cacheRead += (t.cacheRead * r.cacheRead) / 1_000_000;
    out.cacheWrite += (t.cacheWrite * r.cacheWrite) / 1_000_000;
  }
  return out;
}

/** Full per-tier rates map from the gateway, cached for the process lifetime. */
let cachedRatesMap: Record<string, FlatRates> | null | undefined;
async function gatewayRatesMap(baseUrl: string): Promise<Record<string, FlatRates> | null> {
  if (cachedRatesMap !== undefined) return cachedRatesMap;
  try {
    const origin = baseUrl.replace(/\/v1\/?$/, "");
    const res = await fetch(`${origin}/rates`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return (cachedRatesMap = await res.json() as Record<string, FlatRates>);
  } catch {
    // gateway down or timed out — fall back to the static config cost.
  }
  return null; // don't cache a miss; retry next request
}
```

- Replace the `/usage` route (lines 405–411):

```ts
  if (url.startsWith("/usage") && req.method === "GET") {
    const daysParam = new URL(url, "http://x").searchParams.get("days") ?? "30";
    const days = daysParam === "all" ? undefined : Math.max(1, Number(daysParam) || 30);
    void gatewayRatesMap(config.gateway.baseUrl).then((ratesMap) => {
      const summary = usageLedger().summary(days);
      const costByKind = costByKindFromTiers(summary.byTier, ratesMap, config.gateway.cost);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ ...summary, costByKind }));
    });
    return;
  }
```

- Delete `apps/host/src/core/usage-store.ts`. Run `grep -rn "usage-store" apps/host/src apps/host/test` — every hit must be gone (migrate.ts stays: chat-store and file-registry still use it).

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test --workspace=@steward/host && npm run typecheck --workspace=@steward/host`
Expected: PASS (including the untouched migrate/chat-store/auth suites).

- [ ] **Step 7: Commit**

```bash
git add apps/host package-lock.json
git commit -m "feat(host): usage attribution headers via Pi, /usage from shared ledger with ?days + costByKind"
```

---

### Task 6: background services attribution (mail-promoter, action-center, mail-mirror)

**Files:**
- Modify: `apps/mail-promoter/src/llm.ts`, `apps/mail-promoter/src/cli.ts:41,120`, `apps/mail-promoter/package.json`
- Modify: `apps/action-center/src/llm.ts`, `apps/action-center/package.json`
- Modify: `apps/mail-mirror/src/role-classify.ts`, `apps/mail-mirror/package.json`
- Test: `apps/mail-promoter/test/llm-headers.test.ts`, `apps/action-center/test/llm-headers.test.ts`, `apps/mail-mirror/test/role-classify-headers.test.ts` (create all three)

**Interfaces:**
- Consumes: `usageHeaders` from `@steward/protocol` (add `"@steward/protocol": "*"` to each package's dependencies; run `npm install`).
- Produces: `gatewayChat` in mail-promoter gains optional `usage?: { service: string; action: string }` in its cfg. action-center's `gatewayChat` and mail-mirror's `makeRoleClassifier` label themselves unconditionally (single-purpose clients).

- [ ] **Step 1: Write the failing tests**

`apps/mail-promoter/test/llm-headers.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { gatewayChat } from "../src/llm.ts";

test("gatewayChat sends usage attribution headers when configured", async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  const chat = gatewayChat(
    { endpoint: "http://x/v1/chat/completions", model: "tier-5", usage: { service: "mail-promoter", action: "triage" } },
    fetchImpl,
  );
  await chat("sys", "user");
  assert.equal(seen["x-usage-service"], "mail-promoter");
  assert.equal(seen["x-usage-action"], "triage");
});
```

`apps/action-center/test/llm-headers.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { gatewayChat } from "../src/llm.ts";

test("action-center chat always labels itself action-center/scan", async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  await gatewayChat({ endpoint: "http://x", model: "tier-5" }, fetchImpl)("sys", "user");
  assert.equal(seen["x-usage-service"], "action-center");
  assert.equal(seen["x-usage-action"], "scan");
});
```

`apps/mail-mirror/test/role-classify-headers.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { makeRoleClassifier } from "../src/role-classify.ts";

test("role classifier labels itself mail-mirror/role-classify", async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return new Response(JSON.stringify({ choices: [{ message: { content: "inbox" } }] }), { status: 200 });
  }) as typeof fetch;
  const role = await makeRoleClassifier({ endpoint: "http://x", model: "tier-2" }, fetchImpl)("Posta in arrivo");
  assert.equal(role, "inbox");
  assert.equal(seen["x-usage-service"], "mail-mirror");
  assert.equal(seen["x-usage-action"], "role-classify");
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npm test --workspace=@steward/mail-promoter && npm test --workspace=@steward/action-center && npm test --workspace=@steward/mail-mirror`
(If a workspace package name differs, read its package.json `name` and use that.)
Expected: the three new tests FAIL on missing headers/param.

- [ ] **Step 3: Implement**

`apps/mail-promoter/src/llm.ts` — extend cfg and spread the headers:

```ts
import { usageHeaders } from "@steward/protocol";

export type Chat = (system: string, user: string) => Promise<string>;

/** Build an OpenAI-compatible chat function over the gateway (or any OpenAI endpoint). */
export function gatewayChat(
  cfg: { endpoint: string; model: string; apiKey?: string; usage?: { service: string; action: string } },
  fetchImpl: typeof fetch = fetch,
): Chat {
  return async (system, user) => {
    const res = await fetchImpl(cfg.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        ...(cfg.usage ? usageHeaders(cfg.usage.service, cfg.usage.action) : {}),
      },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`gateway chat ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  };
}
```

`apps/mail-promoter/src/cli.ts` — label the two call sites (classify+distil run as ONE call, so the action is `triage`):
- line ~41: `gatewayChat({ endpoint: cfg.llmEndpoint, model: cfg.triageModel, apiKey: cfg.apiKey, usage: { service: "mail-promoter", action: "triage" } })`
- line ~120 (eval path): `gatewayChat({ endpoint: cfg.llmEndpoint, model, apiKey: cfg.apiKey, usage: { service: "mail-promoter", action: "eval" } })`

`apps/action-center/src/llm.ts` — single-purpose client, label unconditionally. Add to the headers object inside the returned function:

```ts
import { usageHeaders } from "@steward/protocol";
// in the fetch call:
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...usageHeaders("action-center", "scan"),
      },
```

`apps/mail-mirror/src/role-classify.ts` — same, inside `makeRoleClassifier`'s fetch:

```ts
import { usageHeaders } from "@steward/protocol";
// in the fetch call:
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
          ...usageHeaders("mail-mirror", "role-classify"),
        },
```

Add `"@steward/protocol": "*"` to the `dependencies` of all three package.json files; run `npm install`.

- [ ] **Step 4: Run tests and typechecks in all three workspaces**

Run: `for w in mail-promoter action-center mail-mirror; do (cd apps/$w && npm test && npm run typecheck) || exit 1; done`
Expected: PASS everywhere (existing suites too).

- [ ] **Step 5: Commit**

```bash
git add apps/mail-promoter apps/action-center apps/mail-mirror package-lock.json
git commit -m "feat: usage attribution headers from mail-promoter, action-center, mail-mirror"
```

---

### Task 7: embeddings attribution (embed-configs + wiki embeds)

**Files:**
- Modify: `apps/mail-mirror/src/embed-config.ts` (add `service` param, default `"mail-mirror"`)
- Modify: `apps/mail-mcp/src/index.ts:30` (pass `"mail-mcp"`)
- Modify: `apps/calendar-mcp/src/embed-config.ts`, `apps/contacts-mcp/src/embed-config.ts`
- Modify: `apps/llm-wiki/src/lib/embedding.ts` (~line 91)
- Modify: package.json of calendar-mcp / contacts-mcp (add `"@steward/protocol": "*"` if not present; mail-mirror got it in Task 6)
- Test: extend `apps/mail-mirror/test/embed-config.test.ts`; create `apps/calendar-mcp/test/embed-config-headers.test.ts`, `apps/contacts-mcp/test/embed-config-headers.test.ts`, `apps/llm-wiki/src/lib/embedding-usage.test.ts`

**Interfaces:**
- Consumes: `usageHeaders` from `@steward/protocol`; `EmbeddingConfig.extraHeaders` (already supported by `@steward/embedding`; `isSafeExtraHeader` allows `x-usage-*` names).
- Produces: `loadEmbedConfig(env?, service?)` in mail-mirror (`service` defaults to `"mail-mirror"`); wiki exports `withUsageAttribution(cfg: EmbeddingConfig): EmbeddingConfig` from `apps/llm-wiki/src/lib/embedding.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mail-mirror/test/embed-config.test.ts` (match its existing import style):

```ts
test("loadEmbedConfig attaches usage attribution extraHeaders with the caller's service", () => {
  const cfg = loadEmbedConfig({}, "mail-mcp");
  assert.ok(cfg);
  assert.equal(cfg.extraHeaders?.["x-usage-service"], "mail-mcp");
  assert.equal(cfg.extraHeaders?.["x-usage-action"], "embed");
  const def = loadEmbedConfig({});
  assert.equal(def?.extraHeaders?.["x-usage-service"], "mail-mirror");
});
```

`apps/calendar-mcp/test/embed-config-headers.test.ts` (contacts-mcp identical with `contacts-mcp`):

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadEmbedConfig } from "../src/embed-config.ts";

test("embed config carries calendar-mcp/embed attribution", () => {
  const cfg = loadEmbedConfig({});
  assert.ok(cfg);
  assert.equal(cfg.extraHeaders?.["x-usage-service"], "calendar-mcp");
  assert.equal(cfg.extraHeaders?.["x-usage-action"], "embed");
});
```

`apps/llm-wiki/src/lib/embedding-usage.test.ts` (wiki tests run with its own runner — check `apps/llm-wiki/package.json` `test` script and mirror the framework of the sibling `embedding.test.ts`; the assertions below are framework-portable):

```ts
import { describe, expect, it } from "vitest";
import { withUsageAttribution } from "./embedding";

describe("withUsageAttribution", () => {
  it("labels gateway endpoints as llm-wiki/embed", () => {
    const cfg = withUsageAttribution({ endpoint: "http://127.0.0.1:4000/v1/embeddings", model: "local-embed" } as never);
    expect(cfg.extraHeaders?.["x-usage-service"]).toBe("llm-wiki");
    expect(cfg.extraHeaders?.["x-usage-action"]).toBe("embed");
  });
  it("never labels third-party endpoints", () => {
    const cfg = withUsageAttribution({ endpoint: "https://api.openai.com/v1/embeddings", model: "text-embedding-3-small" } as never);
    expect(cfg.extraHeaders?.["x-usage-service"]).toBeUndefined();
  });
});
```

(If the wiki uses a different runner than vitest, translate imports 1:1 — same three assertions.)

- [ ] **Step 2: Run to verify failures**

Run each touched workspace's `npm test`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

`apps/mail-mirror/src/embed-config.ts`:

```ts
import type { EmbeddingConfig } from "@steward/embedding";
import { usageHeaders } from "@steward/protocol";

export function loadEmbedConfig(env: NodeJS.ProcessEnv = process.env, service = "mail-mirror"): EmbeddingConfig | null {
  const endpoint = env.MAIL_EMBED_ENDPOINT ?? "http://127.0.0.1:4000/v1/embeddings";
  if (!endpoint || endpoint === "off") return null;
  const cfg: EmbeddingConfig = {
    endpoint,
    model: env.MAIL_EMBED_MODEL ?? "local-embed",
    extraHeaders: usageHeaders(service, "embed"),
  };
  if (env.MAIL_EMBED_API_KEY) cfg.apiKey = env.MAIL_EMBED_API_KEY;
  const dim = env.MAIL_EMBED_DIM ? Number(env.MAIL_EMBED_DIM) : NaN;
  if (Number.isFinite(dim) && dim > 0) cfg.outputDimensionality = dim;
  return cfg;
}
```

`apps/mail-mcp/src/index.ts` line 30: `const embedCfg = loadEmbedConfig(process.env, "mail-mcp");`

`apps/calendar-mcp/src/embed-config.ts` and `apps/contacts-mcp/src/embed-config.ts`: same one-line addition inside the built cfg — `extraHeaders: usageHeaders("calendar-mcp", "embed")` (resp. `"contacts-mcp"`), plus the `usageHeaders` import. Match each file's existing env-var names; only add the field.

`apps/llm-wiki/src/lib/embedding.ts` — add near the top (after imports), and wrap the cfg in the `fetchEmbedding` wrapper (line ~97, `coreFetchEmbedding(text, cfg, …)` → `coreFetchEmbedding(text, withUsageAttribution(cfg), …)`):

```ts
// The steward gateway meters embeddings by attribution headers. Only the
// local gateway ever receives them — never third-party endpoints.
const STEWARD_GATEWAY_ORIGINS = new Set(["http://127.0.0.1:4000", "http://localhost:4000"]);

export function withUsageAttribution(cfg: EmbeddingConfig): EmbeddingConfig {
  try {
    if (!cfg.endpoint || !STEWARD_GATEWAY_ORIGINS.has(new URL(cfg.endpoint).origin)) return cfg;
  } catch {
    return cfg;
  }
  return {
    ...cfg,
    extraHeaders: { ...(cfg.extraHeaders ?? {}), "x-usage-service": "llm-wiki", "x-usage-action": "embed" },
  };
}
```

(The wiki intentionally uses literal header names — it must stay importable outside the monorepo, so no `@steward/protocol` dependency.)

- [ ] **Step 4: Run tests + typechecks in mail-mirror, mail-mcp, calendar-mcp, contacts-mcp, llm-wiki**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail-mirror apps/mail-mcp apps/calendar-mcp apps/contacts-mcp apps/llm-wiki package-lock.json
git commit -m "feat: embed-call usage attribution from all embedding consumers"
```

---

### Task 8: wiki chat attribution (gateway endpoints only)

**Files:**
- Modify: `apps/llm-wiki/src/lib/llm-providers.ts` (custom-provider chat_completions branch, ~line 960)
- Test: `apps/llm-wiki/src/lib/llm-providers-usage.test.ts` (create, same runner as `llm-providers.test.ts`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function stewardGatewayUsageHeaders(url: string): Record<string, string>` in `llm-providers.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { stewardGatewayUsageHeaders, getProviderConfig } from "./llm-providers";

describe("stewardGatewayUsageHeaders", () => {
  it("returns llm-wiki/chat headers for the local gateway only", () => {
    expect(stewardGatewayUsageHeaders("http://127.0.0.1:4000/v1/chat/completions")).toEqual({
      "x-usage-service": "llm-wiki",
      "x-usage-action": "chat",
    });
    expect(stewardGatewayUsageHeaders("https://api.openai.com/v1/chat/completions")).toEqual({});
    expect(stewardGatewayUsageHeaders("not a url")).toEqual({});
  });

  it("is wired into the custom provider config for gateway endpoints", () => {
    const cfg = getProviderConfig({
      provider: "custom",
      customEndpoint: "http://127.0.0.1:4000/v1",
      apiKey: "",
      model: "tier-5",
      ollamaUrl: "",
    } as never);
    expect(cfg.headers["x-usage-service"]).toBe("llm-wiki");
  });
});
```

(Adjust the `LlmConfig` literal fields to whatever the type minimally requires — read the `LlmConfig` type in `apps/llm-wiki/src/stores/wiki-store.ts` and fill required fields with neutral values; the two assertions are the contract.)

- [ ] **Step 2: Run to verify it fails** (wiki test command from its package.json)

- [ ] **Step 3: Implement**

In `llm-providers.ts`, near `localLlmOriginHeader` (~line 117):

```ts
// The steward gateway (apps/llm-gateway) meters LLM calls via attribution
// headers. Send them ONLY to the local gateway — never to third-party APIs.
const STEWARD_GATEWAY_ORIGINS = new Set(["http://127.0.0.1:4000", "http://localhost:4000"]);

export function stewardGatewayUsageHeaders(url: string): Record<string, string> {
  try {
    if (!STEWARD_GATEWAY_ORIGINS.has(new URL(url).origin)) return {};
  } catch {
    return {};
  }
  return { "x-usage-service": "llm-wiki", "x-usage-action": "chat" };
}
```

In the `custom` branch (chat_completions path, the non-azure headers object around line 966), add one spread after the origin workaround line:

```ts
          ...(!azure && isLocalOrPrivateHttpEndpoint(url) ? localLlmOriginHeader() : {}),
          ...stewardGatewayUsageHeaders(url),
```

- [ ] **Step 4: Run wiki tests + typecheck** — expected PASS (including existing `llm-providers.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/llm-wiki
git commit -m "feat(wiki): usage attribution headers on chat calls to the local gateway"
```

---

### Task 9: Usage page redesign (web)

**Files:**
- Rewrite: `apps/web/src/components/usage-page.tsx` (App.tsx wiring is unchanged: same props)

**Interfaces:**
- Consumes: `GET {httpBase}/usage?days=7|30|all` → `LedgerSummary & { costByKind }` from Task 5. No new deps.

- [ ] **Step 1: Replace the file**

Full new `apps/web/src/components/usage-page.tsx`:

```tsx
/**
 * Usage page — the complete observability view over the shared LLM usage
 * ledger. Fetches the host's `/usage?days=` JSON (written by the gateway, one
 * row per LLM call, attributed per service/action) and renders totals, cost
 * by service / action / day / model, tool stats and recent calls. Hand-rolled
 * SVG, no charting dependency.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authFetch } from "@/lib/auth";
import { cn } from "@/lib/utils";

interface Totals { calls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }
interface ServiceRow { service: string; cost: number; calls: number; tokens: number }
interface ActionRow { service: string; action: string; calls: number; cost: number; tokens: number; avgCost: number }
interface DayRow { day: string; service: string; cost: number; calls: number; tokens: number }
interface ModelRow { model: string; cost: number; tokens: number; calls: number }
interface RecentRow {
  ts: number; service: string; action: string; model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; durationMs: number; ok: number;
}
interface ToolRow { tool: string; calls: number; errors: number; totalMs: number; avgMs: number; maxMs: number }
interface ToolTotals { calls: number; errors: number; totalMs: number }
interface CostByKind { input: number; output: number; cacheRead: number; cacheWrite: number }
interface UsageSummary {
  totals: Totals;
  byService: ServiceRow[];
  byAction: ActionRow[];
  byDay: DayRow[];
  byModel: ModelRow[];
  recent: RecentRow[];
  byTool: ToolRow[];
  toolTotals: ToolTotals;
  costByKind: CostByKind;
}

type Period = "7" | "30" | "all";
const PERIODS: { key: Period; label: string }[] = [
  { key: "7", label: "7 giorni" },
  { key: "30", label: "30 giorni" },
  { key: "all", label: "Tutto" },
];

/** The four token kinds, with display label and a stable color. */
const KINDS = [
  { key: "input", label: "Input", color: "#6366f1" },
  { key: "output", label: "Output", color: "#10b981" },
  { key: "cacheRead", label: "Cache read", color: "#f59e0b" },
  { key: "cacheWrite", label: "Cache write", color: "#ec4899" },
] as const;

/** Stable per-service colors (fallback palette for services not listed). */
const SERVICE_COLORS: Record<string, string> = {
  host: "#6366f1",
  "mail-promoter": "#10b981",
  "action-center": "#f59e0b",
  "mail-mirror": "#ec4899",
  "llm-wiki": "#8b5cf6",
  "mail-mcp": "#06b6d4",
  "calendar-mcp": "#84cc16",
  "contacts-mcp": "#f97316",
  unknown: "#ef4444",
};
const FALLBACK_COLORS = ["#14b8a6", "#a855f7", "#eab308", "#64748b"];
function serviceColor(service: string, index: number): string {
  return SERVICE_COLORS[service] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

const usd = (n: number) => `$${n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toFixed(6)}`;
const intl = (n: number) => Math.round(n).toLocaleString("it-IT");
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n));
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s` : `${Math.round(n)}ms`);
/** Strip the `mcp__server__` prefix so tool names read cleanly. */
const bareTool = (name: string) => name.replace(/^mcp__[^_]+__/, "") || name;
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function UsagePage({ httpBase, token, onUnauthorized }: { httpBase: string; token: string | null; onUnauthorized: () => void }) {
  const [period, setPeriod] = useState<Period>("30");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${httpBase}/usage?days=${period}`, token, onUnauthorized);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as UsageSummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [httpBase, token, onUnauthorized, period]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-destructive text-sm">Impossibile caricare i costi: {error}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
          Riprova
        </Button>
      </div>
    );
  }
  if (!data) {
    return <div className="text-muted-foreground p-6 text-sm">{loading ? "Caricamento…" : "—"}</div>;
  }

  const t = data.totals;
  const totalTokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  const costToday = data.byDay.filter((d) => d.day === todayKey()).reduce((s, d) => s + d.cost, 0);
  const hasUnknown = data.byService.some((s) => s.service === "unknown");
  const costByKind = KINDS.map((k) => ({ ...k, tokens: t[k.key], cost: data.costByKind[k.key] }));

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Usage</h2>
          <p className="text-muted-foreground text-sm">
            Ogni chiamata LLM, per servizio e azione · {intl(t.calls)} chiamate nel periodo
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border">
            {PERIODS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={period === p.key ? "secondary" : "ghost"}
                className="rounded-none first:rounded-l-md last:rounded-r-md"
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? "…" : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Costo totale" value={usd(t.cost)} />
        <Stat label="Costo oggi" value={usd(costToday)} />
        <Stat label="Chiamate LLM" value={intl(t.calls)} />
        <Stat label="Token totali" value={compact(totalTokens)} sub={`${intl(totalTokens)} token`} />
      </div>

      {/* Cost by service */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per servizio</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasUnknown && (
            <p className="text-destructive text-xs">
              ⚠ Sono presenti chiamate «unknown»: un chiamante non manda gli header di attribuzione.
            </p>
          )}
          {data.byService.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessuna chiamata nel periodo.</p>
          ) : (
            <>
              <StackedBar
                segments={data.byService.map((s, i) => ({ label: s.service, color: serviceColor(s.service, i), value: s.cost }))}
                format={usd}
              />
              <div className="space-y-2">
                {(() => {
                  const max = Math.max(...data.byService.map((s) => s.cost), 1e-9);
                  return data.byService.map((s, i) => (
                    <div key={s.service} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 font-medium">
                          <span className="size-2.5 rounded-sm" style={{ background: serviceColor(s.service, i) }} />
                          {s.service}
                          {s.service === "unknown" && <Badge variant="destructive">da etichettare</Badge>}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {usd(s.cost)} · {intl(s.calls)} chiamate · {compact(s.tokens)} tok
                        </span>
                      </div>
                      <div className="bg-muted h-2 overflow-hidden rounded-full">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${(s.cost / max) * 100}%`, background: serviceColor(s.service, i) }}
                        />
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Cost by action — the per-piece price list */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per azione</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byAction.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessuna azione nel periodo.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <Th>Servizio</Th>
                    <Th>Azione</Th>
                    <Th right>Chiamate</Th>
                    <Th right>Token</Th>
                    <Th right>Costo medio / pezzo</Th>
                    <Th right>Costo totale</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAction.map((a) => (
                    <tr key={`${a.service}/${a.action}`} className="border-border border-t">
                      <Td className="font-medium">{a.service}</Td>
                      <Td className="font-mono">{a.action}</Td>
                      <Td right>{intl(a.calls)}</Td>
                      <Td right>{compact(a.tokens)}</Td>
                      <Td right>{usd(a.avgCost)}</Td>
                      <Td right className="font-medium">{usd(a.cost)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cost per day, stacked by service */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per giorno</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byDay.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessun dato.</p>
          ) : (
            <StackedDayBars rows={data.byDay} serviceOrder={data.byService.map((s) => s.service)} />
          )}
        </CardContent>
      </Card>

      {/* Cost by token kind */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per tipo di token</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <StackedBar segments={costByKind.map((k) => ({ label: k.label, color: k.color, value: k.cost }))} format={usd} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {costByKind.map((k) => (
              <div key={k.key} className="space-y-0.5">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="size-2.5 rounded-sm" style={{ background: k.color }} />
                  <span className="text-muted-foreground">{k.label}</span>
                </div>
                <div className="text-sm font-semibold tabular-nums">{usd(k.cost)}</div>
                <div className="text-muted-foreground text-xs tabular-nums">{compact(k.tokens)} tok</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Cost by model */}
      {data.byModel.length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Costo per modello</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(() => {
              const max = Math.max(...data.byModel.map((m) => m.cost), 1e-9);
              return data.byModel.map((m) => (
                <div key={m.model} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{m.model || "—"}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {usd(m.cost)} · {compact(m.tokens)} tok · {intl(m.calls)} chiamate
                    </span>
                  </div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div className="bg-primary h-full rounded-full" style={{ width: `${(m.cost / max) * 100}%` }} />
                  </div>
                </div>
              ));
            })()}
          </CardContent>
        </Card>
      )}

      {/* Tool usage (unchanged data source: host tool_calls) */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Tool</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byTool.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessuna invocazione registrata.</p>
          ) : (
            <>
              <div className="text-muted-foreground mb-3 flex gap-4 text-xs">
                <span><span className="text-foreground font-semibold tabular-nums">{intl(data.toolTotals.calls)}</span> chiamate</span>
                <span><span className="text-foreground font-semibold tabular-nums">{intl(data.toolTotals.errors)}</span> errori</span>
                <span><span className="text-foreground font-semibold tabular-nums">{ms(data.toolTotals.totalMs)}</span> totali</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <Th>Tool</Th>
                      <Th right>Chiamate</Th>
                      <Th right>Errori</Th>
                      <Th right>Media</Th>
                      <Th right>Max</Th>
                      <Th right>Totale</Th>
                      <Th>Frequenza</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const maxCalls = Math.max(...data.byTool.map((x) => x.calls), 1);
                      return data.byTool.map((x) => (
                        <tr key={x.tool} className="border-border border-t">
                          <Td className="font-mono">{bareTool(x.tool)}</Td>
                          <Td right>{intl(x.calls)}</Td>
                          <Td right className={x.errors > 0 ? "text-destructive font-medium" : ""}>{intl(x.errors)}</Td>
                          <Td right>{ms(x.avgMs)}</Td>
                          <Td right>{ms(x.maxMs)}</Td>
                          <Td right>{ms(x.totalMs)}</Td>
                          <Td>
                            <div className="bg-muted h-1.5 w-24 overflow-hidden rounded-full">
                              <div className="bg-primary h-full rounded-full" style={{ width: `${(x.calls / maxCalls) * 100}%` }} />
                            </div>
                          </Td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Recent calls */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Chiamate recenti</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessuna chiamata registrata.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <Th>Quando</Th>
                    <Th>Servizio</Th>
                    <Th>Azione</Th>
                    <Th>Modello</Th>
                    <Th right>In</Th>
                    <Th right>Out</Th>
                    <Th right>Durata</Th>
                    <Th right>Costo</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r, i) => (
                    <tr key={i} className={cn("border-border border-t", r.ok === 0 && "text-destructive")}>
                      <Td>{formatTs(r.ts)}</Td>
                      <Td className="font-medium">{r.service}</Td>
                      <Td className="font-mono">{r.action}</Td>
                      <Td>
                        <Badge variant="outline">{r.model || "—"}</Badge>
                      </Td>
                      <Td right>{compact(r.input + r.cacheRead)}</Td>
                      <Td right>{compact(r.output)}</Td>
                      <Td right>{ms(r.durationMs)}</Td>
                      <Td right className="font-medium">{r.ok === 0 ? "errore" : usd(r.cost)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card size="sm">
      <CardContent className="p-4">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-muted-foreground mt-0.5 text-xs tabular-nums">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** Horizontal proportional bar split into colored segments. */
function StackedBar({
  segments,
  format,
}: {
  segments: { label: string; color: string; value: number }[];
  format: (n: number) => string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <div className="bg-muted h-3 rounded-full" />;
  return (
    <div className="flex h-3 overflow-hidden rounded-full">
      {segments.map((s) => (
        <div
          key={s.label}
          className="h-full first:rounded-l-full last:rounded-r-full"
          style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
          title={`${s.label}: ${format(s.value)} (${((s.value / total) * 100).toFixed(1)}%)`}
        />
      ))}
    </div>
  );
}

/** Vertical bar chart (SVG) of per-day cost, stacked by service. */
function StackedDayBars({ rows, serviceOrder }: { rows: DayRow[]; serviceOrder: string[] }) {
  // rows arrive day DESC with one row per (day, service); pivot to day → segments.
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const byDay = new Map<string, DayRow[]>();
  for (const r of rows) {
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }
  const dayTotal = (d: string) => (byDay.get(d) ?? []).reduce((s, r) => s + r.cost, 0);
  const max = Math.max(...days.map(dayTotal), 1e-9);
  const w = Math.max(days.length * 36, 240);
  const h = 160;
  const pad = 24;
  const bw = Math.min(28, (w - pad) / days.length - 8);
  const colorFor = (service: string) => serviceColor(service, Math.max(0, serviceOrder.indexOf(service)));
  return (
    <div className="overflow-x-auto">
      <svg width={w} height={h} className="block" role="img" aria-label="Costo per giorno per servizio">
        {days.map((day, i) => {
          const x = pad + i * ((w - pad) / days.length);
          let y = h - 16;
          const segs = (byDay.get(day) ?? []).slice().sort((a, b) => b.cost - a.cost);
          return (
            <g key={day}>
              {segs.map((seg) => {
                const bh = ((h - pad - 16) * seg.cost) / max;
                y -= bh;
                return (
                  <rect key={seg.service} x={x} y={y} width={bw} height={Math.max(bh, 0.5)} rx={1.5} fill={colorFor(seg.service)}>
                    <title>{`${day} · ${seg.service}: ${usd(seg.cost)} · ${compact(seg.tokens)} tok · ${seg.calls} chiamate`}</title>
                  </rect>
                );
              })}
              <text x={x + bw / 2} y={h - 4} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                {day.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={cn("px-2 py-1.5 font-medium", right && "text-right")}>{children}</th>;
}
function Td({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn("px-2 py-1.5 tabular-nums", right && "text-right", className)}>{children}</td>;
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString("it-IT", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
```

- [ ] **Step 2: Typecheck / build**

Run: `npm run typecheck --workspace=@steward/web` (if no typecheck script, `npm run build --workspace=@steward/web`).
Expected: clean.

- [ ] **Step 3: Visual smoke**

Start host + gateway + web dev server per repo convention, open the Usage page, switch the three periods, hover the stacked bars. Verify the "unknown" warning does NOT appear once all callers are labeled (and DOES appear when calling the gateway with `curl` without headers).

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): Usage page redesign — per-service/per-action costs, period filter, recent calls"
```

---

### Task 10: e2e smoke — gateway call → ledger row → summary exposes it

**Files:**
- Test: `apps/llm-gateway/test/metering-e2e.test.ts` (create)

- [ ] **Step 1: Write the test** (this is the whole task — the production code already exists):

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as { port: number }).port);
  }));
}

process.env.USAGE_DIR = mkdtempSync(join(tmpdir(), "gw-e2e-"));

test("e2e: labeled gateway call is exposed by the ledger summary the /usage page reads", async (t) => {
  const provider = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "cmpl-1", model: "deepseek-v4-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
  });
  const providerPort = await listen(provider);
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  process.env.DEEPSEEK_API_KEY = "sk-test";
  const { startGateway } = await import("../src/gateway.ts");
  const gw = startGateway(0);
  await new Promise((resolve) => gw.on("listening", resolve));
  const gwPort = (gw.address() as { port: number }).port;
  const { usageLedger } = await import("@steward/usage-ledger");
  t.after(() => { gw.close(); provider.close(); });

  const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "e2e-svc", "x-usage-action": "e2e-act" },
    body: JSON.stringify({ model: "tier-5", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);

  const s = usageLedger().summary(7);
  const svc = s.byService.find((x) => x.service === "e2e-svc");
  assert.ok(svc, "byService exposes the labeled service");
  assert.equal(svc.calls, 1);
  assert.ok(svc.cost > 0);
  const act = s.byAction.find((x) => x.service === "e2e-svc" && x.action === "e2e-act");
  assert.ok(act, "byAction exposes the labeled action");
  assert.ok(Math.abs(act.avgCost - act.cost) < 1e-12);
  assert.equal(s.recent[0].service, "e2e-svc");
  assert.equal(s.byDay.some((d) => d.service === "e2e-svc"), true);

  // Spec: metering must never break an LLM call. Kill the ledger DB and
  // verify the gateway still answers 200 (recordCall catches and warns).
  usageLedger().raw.close();
  const res2 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usage-service": "e2e-svc", "x-usage-action": "e2e-act" },
    body: JSON.stringify({ model: "tier-5", messages: [{ role: "user", content: "hi again" }] }),
  });
  assert.equal(res2.status, 200);
});
```

- [ ] **Step 2: Run the whole gateway suite + every touched workspace's tests one final time**

Run: `npm test --workspace=@steward/llm-gateway && npm test --workspace=@steward/usage-ledger && npm test --workspace=@steward/protocol && npm test --workspace=@steward/host`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/llm-gateway
git commit -m "test(gateway): e2e smoke — labeled call lands in ledger and summary"
```

---

## Plan-level notes for the implementer

- **Ledger singleton in tests:** `usageLedger()` caches its DB on first call per process. Each gateway test FILE sets `process.env.USAGE_DIR` at module top (before any import of the ledger) — never per-test.
- **Deviation from spec (documented):** the `/usage` response returns a server-computed `costByKind` instead of the old flat `rates` field — with multiple tiers in the ledger a single flat rate can no longer price the token-kind split correctly. The spec's UI card is unchanged.
- **mail-promoter action naming:** classify+distil run as ONE gateway call (see `apps/mail-promoter/src/config.ts` comment), so the action label is `triage`; the separate `distill` label in the spec table does not exist as a separate call.
- **Host `x-usage-session`:** not sent (Pi registers provider headers once per connection, before chats exist). `session_id` is nullable by design; host rows group by service/action.
- **After the last task**, verify end-to-end per the repo's run conventions: start gateway + host, send a chat message from the web UI, run a mail-promoter/action-center cycle, then open the Usage page and confirm each service appears with its own label.
