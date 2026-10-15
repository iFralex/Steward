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

test('native diagnostics distinguish unconfigured and unreachable bridge states',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {eventKitBridgeStatus}=await import('../src/eventkit-client.ts');
  const previous=process.env.STEWARD_CALENDAR_BRIDGE_DIR;
  const root=await mkdtemp(join(tmpdir(),'calendar-status-'));
  try {
    delete process.env.STEWARD_CALENDAR_BRIDGE_DIR;
    assert.equal((await eventKitBridgeStatus()).configured,false);
    process.env.STEWARD_CALENDAR_BRIDGE_DIR=root;
    const status=await eventKitBridgeStatus(20);
    assert.equal(status.configured,true);assert.equal(status.reachable,false);assert.equal(status.authorization,undefined);
  } finally {if(previous===undefined)delete process.env.STEWARD_CALENDAR_BRIDGE_DIR;else process.env.STEWARD_CALENDAR_BRIDGE_DIR=previous;await rm(root,{recursive:true,force:true});}
});

test('EventKit creation preserves calendarId without requiring a unique title',async()=>{
  const {mkdtemp,mkdir,readdir,readFile,writeFile,unlink,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {createEventKit}=await import('../src/eventkit-client.ts');
  const root=await mkdtemp(join(tmpdir(),'calendar-create-'));
  const previous=process.env.STEWARD_CALENDAR_BRIDGE_DIR;process.env.STEWARD_CALENDAR_BRIDGE_DIR=root;
  const requests=join(root,'requests'),responses=join(root,'responses');
  await mkdir(requests);await mkdir(responses);
  try {
    const result=createEventKit({calendarId:'synthetic-polimi',summary:'Synthetic meeting',start:'2026-10-16T13:00:00Z',end:'2026-10-16T14:00:00Z'});
    let file:string|undefined;const deadline=Date.now()+2_000;
    while(!file&&Date.now()<deadline){file=(await readdir(requests)).find(name=>name.endsWith('.json'));if(!file)await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(file);const request=JSON.parse(await readFile(join(requests,file),'utf8'));
    assert.equal(request.method,'create');assert.equal(request.params.calendarId,'synthetic-polimi');assert.equal(request.params.calendar,undefined);
    await writeFile(join(responses,file),JSON.stringify({ok:true,result:{uid:'synthetic-event'}}));await unlink(join(requests,file));
    assert.equal(await result,'synthetic-event');
  } finally {if(previous===undefined)delete process.env.STEWARD_CALENDAR_BRIDGE_DIR;else process.env.STEWARD_CALENDAR_BRIDGE_DIR=previous;await rm(root,{recursive:true,force:true});}
});
