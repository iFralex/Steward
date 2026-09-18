import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.AUDIT_DIR = mkdtempSync(join(tmpdir(), "action-read-audit-"));
process.env.USAGE_DIR = mkdtempSync(join(tmpdir(), "action-read-usage-"));

import { auditLog } from "@steward/audit-log";
import { usageLedger } from "@steward/usage-ledger";
import { executeObservedReadTool } from "../src/observed-read-tool.ts";

test("background read tools are recorded in Usage and Audit", async () => {
  const result = await executeObservedReadTool(async () => ({ ok: true }), "mcp__calendar__read_event", { uid: "event-1" });
  assert.deepEqual(result, { ok: true });

  await assert.rejects(
    () => executeObservedReadTool(async () => { throw new Error("unavailable"); }, "mcp__mail__read_message", { id: "mail-1" }),
    /unavailable/,
  );

  const tools = usageLedger().summary().byTool;
  assert.equal(tools.find((entry) => entry.tool === "mcp__calendar__read_event")?.calls, 1);
  assert.equal(tools.find((entry) => entry.tool === "mcp__mail__read_message")?.errors, 1);

  const audit = auditLog().query({ limit: 20 });
  assert.equal(audit.events.filter((event) => event.eventType === "tool.requested").length, 2);
  assert.equal(audit.events.some((event) => event.eventType === "tool.completed" && event.toolName === "mcp__calendar__read_event"), true);
  assert.equal(audit.events.some((event) => event.eventType === "tool.failed" && event.toolName === "mcp__mail__read_message"), true);
});
