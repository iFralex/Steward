import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleStore } from "../../apps/calendar-mcp/src/apple-store.ts";
import { createEventKit, deleteEventKit } from "../../apps/calendar-mcp/src/eventkit-client.ts";
import { IndexDb } from "../../apps/calendar-mcp/src/index-db.ts";
import { applePath } from "../../apps/calendar-mcp/src/paths.ts";
import { syncIndex } from "../../apps/calendar-mcp/src/sync.ts";
import { findCalendarConfirmation } from "../../apps/scheduler/src/write-ops-cli.ts";
import { WriteOpsStore } from "../../packages/write-ops/src/index.ts";

const calendarId = process.argv[2];
assert(calendarId, "usage: journal-bridge.mts <calendar-id>");
assert(process.env.STEWARD_CALENDAR_BRIDGE_DIR, "STEWARD_CALENDAR_BRIDGE_DIR is required");

const temporary = await mkdtemp(join(tmpdir(), "steward-eventkit-journal-"));
process.env.AUDIT_DIR = join(temporary, "audit");
const ops = WriteOpsStore.open(join(temporary, "ops.db"));
const index = IndexDb.open(join(temporary, "calendar-index.db"));
const store = AppleStore.openReadonly(applePath());
const token = `Steward Journal Validation ${crypto.randomUUID()}`;
const start = new Date(Date.now() + 61 * 86_400_000);
start.setMilliseconds(0);
const end = new Date(start.getTime() + 45 * 60_000);
const expected = {
  calendarId,
  summary: token,
  start: start.toISOString(),
  end: end.toISOString(),
  allDay: false,
};
let uid: string | undefined;

try {
  const operationId = ops.start({ kind: "calendar.create", input: expected, expected });
  uid = await createEventKit(expected);

  // Simulate a process dying after EventKit committed but before the bridge
  // response was written into the journal.
  ops.raw.prepare("UPDATE write_ops SET updated_at=? WHERE id=?")
    .run(Math.floor(Date.now() / 1000) - 120, operationId);
  const pending = ops.pendingForConfirmation(["calendar.create"]);
  assert.equal(pending.length, 1, "stale started operation was not recovered");
  assert.equal(pending[0].result, null, "the simulation must not know the EventKit uid");

  let confirmedUid: string | null = null;
  for (let attempt = 0; attempt < 50 && !confirmedUid; attempt += 1) {
    await syncIndex({ store, index, embedConfig: null });
    confirmedUid = findCalendarConfirmation(index, pending[0]);
    if (!confirmedUid) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(confirmedUid, uid, "journal did not uniquely reconcile the committed EventKit event");
  ops.markConfirmed(operationId, { uid: confirmedUid });
  assert.equal(ops.get(operationId)?.status, "confirmed");
  console.log(JSON.stringify({ ok: true, operationId, uid, token }));
} finally {
  if (uid) await deleteEventKit(uid).catch(() => undefined);
  store.close();
  index.close();
  ops.close();
  await rm(temporary, { recursive: true, force: true });
}
