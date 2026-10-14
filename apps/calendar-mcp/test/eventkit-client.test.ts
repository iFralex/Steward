import assert from "node:assert/strict";
import test from "node:test";
import { eventKitCanRepresent } from "../src/eventkit-client.ts";

test("EventKit transport accepts its full recurrence subset", () => {
  assert.equal(eventKitCanRepresent("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8"), true);
  assert.equal(eventKitCanRepresent("FREQ=MONTHLY;BYDAY=1MO,-1FR;BYSETPOS=1"), true);
});

test("unsupported RRULE features are routed away from EventKit without semantic loss", () => {
  assert.equal(eventKitCanRepresent("FREQ=DAILY;BYHOUR=9,17"), false);
  assert.equal(eventKitCanRepresent("FREQ=WEEKLY;WKST=SU;BYDAY=SU"), false);
});
