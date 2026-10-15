import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,readdir,readFile,writeFile,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildMcpBridge} from '@steward/mcp-bridge';

test('real Calendar MCP reports denied native access without touching personal stores or advertising diagnostics as a tool',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'calendar-diagnostics-'));
  const root=join(dir,'bridge');const requests=join(root,'requests'),responses=join(root,'responses');
  await mkdir(requests,{recursive:true});await mkdir(responses,{recursive:true});
  const entry=fileURLToPath(new URL('../../calendar-mcp/src/index.ts',import.meta.url));
  const bridge=await buildMcpBridge({calendar:{command:process.execPath,args:['--import','tsx',entry],env:{
    HOME:dir,WRITE_OPS_DIR:join(dir,'write-ops'),CALENDAR_INDEX_DB:join(dir,'missing-index'),MAIL_EMBED_ENDPOINT:'off',STEWARD_CALENDAR_BRIDGE_DIR:root,
  }}});
  try {
    assert.equal(bridge.connectorStates!().calendar.state,'ready');
    assert.ok(!bridge.tools.some(tool=>/status/i.test(tool.name)));
    const response=bridge.calendarStatus!();
    let file:string|undefined;
    const deadline=Date.now()+3_000;
    while(!file&&Date.now()<deadline){file=(await readdir(requests)).find(name=>name.endsWith('.json'));if(!file)await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(file,'private status request reached the fixture bridge');
    const request=JSON.parse(await readFile(join(requests,file),'utf8'));
    assert.equal(request.method,'status');assert.deepEqual(request.params,{});
    await writeFile(join(responses,file),JSON.stringify({ok:true,result:{authorization:'denied'}}));
    await unlink(join(requests,file));
    const status=await response;
    assert.equal(status.appleStore.readable,false);
    assert.deepEqual(status.bridge,{configured:true,reachable:true,authorization:'denied'});
    assert.deepEqual(await readdir(requests),[]);
  } finally {await bridge.close();await rm(dir,{recursive:true,force:true});}
});
