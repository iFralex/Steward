import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WatchStore, type PendingWatchEvent } from "@steward/watch-engine";
import { createWatchExecutionGuard, resolvedWatchGrants } from "../src/core/watch-grants.ts";

function pending(): PendingWatchEvent {
  return {
    id: "event-1", watchId: "watch-1", chatId: "chat-1", attempts: 0,
    instruction: "Scrivi a mia sorella", resourceRef: "train-ref",
    rules: [{
      id: "mail-30", trigger: { kind: "before_time", field: "estimatedArrivalMs", minutes: 30 }, once: true,
      grants: [{
        tool: "mcp__mail__send_email", maxInvocations: 1,
        constraints: { to: ["sorella@example.com"], subject: "Sto arrivando", bodyTemplate: "Arrivo a {{destination}} alle {{estimatedArrival}} (ritardo {{delayMinutes}})." },
      }],
    }],
    event: {
      type: "watch.before_time", key: "time", timestamp: 1, data: {}, fallbackText: "Mancano 30 minuti.",
      currentState: { destination: "Milano", estimatedArrival: "18:42", delayMinutes: 7, trainNumber: "1234" },
    },
  };
}

test("mail grants render trusted snapshot fields and enforce exact at-most-once input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-grants-"));
  const store = WatchStore.open(join(dir, "watches.db"));
  try {
    const event = pending();
    const [grant] = resolvedWatchGrants(event);
    assert.deepEqual(grant.input, {
      to: ["sorella@example.com"], subject: "Sto arrivando",
      body: "Arrivo a Milano alle 18:42 (ritardo 7).",
    });
    const guard = createWatchExecutionGuard(event, store);
    const altered = await guard.beforeExecute("mcp__mail__send_email", { ...grant.input, bcc: ["other@example.com"] });
    assert.equal(altered.allowed, false);
    const exact = await guard.beforeExecute("mcp__mail__send_email", grant.input!);
    assert.equal(exact.allowed, true);
    await guard.afterExecute?.("mcp__mail__send_email", grant.input!);
    const duplicate = await guard.beforeExecute("mcp__mail__send_email", grant.input!);
    assert.equal(duplicate.allowed, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
