import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarCreateRoute} from '../src/create-route.ts';
const calendars=()=>[{id:'polimi',title:'Calendario'},{id:'icloud',title:'Calendario'},{id:'work',title:'Lavoro'}];

test('identifier-based EventKit route accepts duplicate titles without a recurrence',()=>{
  assert.deepEqual(calendarCreateRoute({calendarId:'polimi'},calendars,true),{kind:'eventkit'});
});
test('missing bridge is diagnosed separately from recurrence support',()=>{
  assert.throws(()=>calendarCreateRoute({calendarId:'polimi'},calendars,false),error=>{
    assert.match(String(error),/CALENDAR_EVENTKIT_UNAVAILABLE/);
    assert.doesNotMatch(String(error),/recurrence/i);assert.match(String(error),/No write was executed/);return true;
  });
});
test('unsupported recurrence has its own diagnostic when the bridge is configured',()=>{
  assert.throws(()=>calendarCreateRoute({calendarId:'polimi',recurrence:'FREQ=DAILY;BYHOUR=9,17'},calendars,true),/CALENDAR_RRULE_UNSUPPORTED/);
});
test('unique titles retain the AppleScript compatibility path',()=>{
  for(const bridgeAvailable of [true,false])assert.deepEqual(calendarCreateRoute({calendarId:'work',recurrence:'FREQ=DAILY;BYHOUR=9,17'},calendars,bridgeAvailable),{kind:'applescript',calendar:'Lavoro'});
  assert.throws(()=>calendarCreateRoute({calendarId:'missing'},calendars,false),/was not found/);
});
