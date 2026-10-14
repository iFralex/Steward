import test from 'node:test';
import assert from 'node:assert/strict';
import { requireCompatibleScope, validateEventUpdate, filterEventText } from '../src/write-validation.ts';
const event={uid:'e',summary:'Certificazione',description:'Project plan',location:null,start:'2026-10-14T09:00:00Z',end:'2026-10-14T10:00:00Z'} as any;
test('one-sided updates are checked against the unchanged live boundary',()=>{
  assert.throws(()=>validateEventUpdate({uid:'e',start:'2026-10-14T11:00:00Z'},event),/end/);
  assert.throws(()=>validateEventUpdate({uid:'e',end:'2026-10-14T08:00:00Z'},event),/end/);
  assert.doesNotThrow(()=>validateEventUpdate({uid:'e',end:'2026-10-14T11:00:00Z'},event));
});
test('compatibility writes never silently ignore future scope or recurring occurrence semantics',()=>{
  assert.throws(()=>requireCompatibleScope({scope:'futureEvents'},false,false),/EventKit/);
  assert.throws(()=>requireCompatibleScope({},false,true),/EventKit/);
  assert.doesNotThrow(()=>requireCompatibleScope({scope:'futureEvents'},true,true));
});
test('fallback text queries filter source content instead of ignoring query',()=>{
  assert.equal(filterEventText([event],'project certificazione').length,1);
  assert.equal(filterEventText([event],'unrelated').length,0);
});
