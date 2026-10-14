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

test('an expired unclaimed native request is removed from the queue',async()=>{
  const {mkdtemp,readdir}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {pingEventKitBridge}=await import('../src/eventkit-client.ts');
  const root=await mkdtemp(join(tmpdir(),'calendar-expiry-'));
  const previous=process.env.STEWARD_CALENDAR_BRIDGE_DIR;process.env.STEWARD_CALENDAR_BRIDGE_DIR=root;
  try {assert.equal(await pingEventKitBridge(20),false);assert.deepEqual(await readdir(join(root,'requests')),[]);}
  finally {if(previous===undefined)delete process.env.STEWARD_CALENDAR_BRIDGE_DIR;else process.env.STEWARD_CALENDAR_BRIDGE_DIR=previous;}
});
