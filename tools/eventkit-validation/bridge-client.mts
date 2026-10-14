import { strict as assert } from "node:assert";
import { createEventKit, deleteEventKit, pingEventKitBridge, updateEventKit } from "../../apps/calendar-mcp/src/eventkit-client.ts";

const calendarId = process.argv[2];
assert(calendarId, "usage: bridge-client.mts <calendar-id>");
const token = `Steward Bridge Validation ${crypto.randomUUID()}`;
assert.equal(await pingEventKitBridge(5_000), true, "launcher bridge did not answer ping");
const start = new Date(Date.now() + 54 * 86_400_000);
const end = new Date(start.getTime() + 3_600_000);
const uid = await createEventKit({
  calendarId,
  summary: token,
  start: start.toISOString(),
  end: end.toISOString(),
  description: "launcher-to-MCP integration",
  alarms: [15],
  recurrence: "FREQ=DAILY;COUNT=2",
});
try {
  await updateEventKit({ uid, summary: `${token} updated`, scope: "thisEvent" });
  await deleteEventKit(uid, "futureEvents");
  console.log(JSON.stringify({ ok: true, uid, token }));
} catch (error) {
  // Best-effort cleanup if the update assertion path fails.
  await deleteEventKit(uid, "futureEvents").catch(() => undefined);
  throw error;
}
