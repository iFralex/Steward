import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarHealthChecks} from '../src/core/calendar-health.ts';

test('readable Calendar database does not imply native write authorization',()=>{
  const checks=calendarHealthChecks({appleStore:{readable:true},bridge:{configured:true,reachable:true,authorization:'denied'}});
  assert.equal(checks[0].ok,true);assert.equal(checks[1].ok,true);assert.equal(checks[2].ok,false);
  assert.equal(checks[2].verified,true);assert.match(checks[2].detail,/Calendars/);
});
test('missing or unreachable bridge leaves Full Access unverified',()=>{
  for(const configured of [false,true]) {
    const checks=calendarHealthChecks({appleStore:{readable:true},bridge:{configured,reachable:false,error:'fixture failure'}});
    assert.equal(checks[1].ok,false);assert.equal(checks[2].ok,false);assert.equal(checks[2].verified,false);
  }
});
test('native access and source database access fail independently',()=>{
  const checks=calendarHealthChecks({appleStore:{readable:false,error:'Full Disk Access needed'},bridge:{configured:true,reachable:true,authorization:'fullAccess'}});
  assert.equal(checks[0].ok,false);assert.equal(checks[2].ok,true);assert.match(checks[2].detail,/read-only/);
  for(const authorization of ['notDetermined','restricted','writeOnly','unknown'] as const)
    assert.equal(calendarHealthChecks({appleStore:{readable:true},bridge:{configured:true,reachable:true,authorization}})[2].ok,false);
});
