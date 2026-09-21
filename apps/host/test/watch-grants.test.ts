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
        constraints: { denyExtraFields: true, fields: {
          to: { kind: "exact", value: ["sorella@example.com"] },
          subject: { kind: "exact", value: "Sto arrivando" },
          body: { kind: "template", template: "Arrivo a {{state.destination}} alle {{state.estimatedArrival}} (ritardo {{state.delayMinutes}})." },
        } },
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
    assert.deepEqual(grant.constraints, {
      denyExtraFields: true,
      fields: {
        to: { kind: "exact", value: ["sorella@example.com"] },
        subject: { kind: "exact", value: "Sto arrivando" },
        body: { kind: "exact", value: "Arrivo a Milano alle 18:42 (ritardo 7)." },
      },
    });
    const input = { to: ["sorella@example.com"], subject: "Sto arrivando", body: "Arrivo a Milano alle 18:42 (ritardo 7)." };
    const guard = createWatchExecutionGuard(event, store);
    const altered = await guard.beforeExecute("mcp__mail__send_email", { ...input, bcc: ["other@example.com"] });
    assert.equal(altered.allowed, false);
    const exact = await guard.beforeExecute("mcp__mail__send_email", input);
    assert.equal(exact.allowed, true);
    await guard.afterExecute?.("mcp__mail__send_email", input);
    const duplicate = await guard.beforeExecute("mcp__mail__send_email", input);
    assert.equal(duplicate.allowed, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one_of and range constraints work for any registered capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-generic-grants-"));
  const store = WatchStore.open(join(dir, "watches.db"));
  try {
    const event = pending();
    event.rules = [{
      id: "mark", event: "train.arrived", once: true,
      grants: [{ tool: "mcp__action-center__mark_action", maxInvocations: 1, constraints: {
        denyExtraFields: true,
        fields: { id: { kind: "range", min: 10, max: 20 }, status: { kind: "one_of", values: ["done", "dismissed"] } },
      } }],
    }];
    const guard = createWatchExecutionGuard(event, store);
    assert.equal((await guard.beforeExecute("mcp__action-center__mark_action", { id: 9, status: "done" })).allowed, false);
    assert.equal((await guard.beforeExecute("mcp__action-center__mark_action", { id: 12, status: "read" })).allowed, false);
    assert.equal((await guard.beforeExecute("mcp__action-center__mark_action", { id: 12, status: "done" })).allowed, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("voice grants are also durably limited to one call_start invocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-voice-grant-"));
  const store = WatchStore.open(join(dir, "watches.db"));
  try {
    const event = pending();
    event.rules = [{ id: "call", event: "train.arrived", once: true, grants: [{ tool: "mcp__voice__call_start", maxInvocations: 1 }] }];
    const guard = createWatchExecutionGuard(event, store);
    const input = { opening_line: "Sei arrivato." };
    assert.equal((await guard.beforeExecute("mcp__voice__call_start", input)).allowed, true);
    await guard.afterExecute?.("mcp__voice__call_start", input);
    assert.equal((await guard.beforeExecute("mcp__voice__call_start", input)).allowed, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relative_time resolves trusted live state with an offset", () => {
  const event = pending();
  event.event.currentState = { estimatedArrivalMs: Date.parse("2026-09-20T19:31:00Z") };
  event.rules = [{
    id: "calendar", event: "train.eta_changed",
    grants: [{ tool: "mcp__calendar__update_event", constraints: { denyExtraFields: true, fields: {
      uid: { kind: "exact", value: "event-1" },
      start: { kind: "relative_time", reference: "state.estimatedArrivalMs", offsetMinutes: -5 },
    } } }],
  }];
  const [grant] = resolvedWatchGrants(event);
  assert.deepEqual(grant.constraints?.fields.start, { kind: "exact", value: "2026-09-20T19:26:00.000Z" });
});
