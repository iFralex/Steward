import test from 'node:test';
import assert from 'node:assert/strict';
import { StartupPreparation, prepareLocalEmbedding } from '../src/core/startup-preparation.ts';
import type { McpBridge } from '@steward/mcp-bridge';
function fixture(prepare:(id:string)=>Promise<{skipped?:string}>,active=()=>0):McpBridge {
  return {tools:[],callTool:async()=>[],close:async()=>{},get activeCalls(){return active();},
    connectorStates:()=>Object.fromEntries(['mail','calendar','contacts'].map(id=>[id,{state:'ready' as const,tools:[]}])),prepareSearch:prepare};
}
test('preparation is serial, keeps the selected order and continues after failure',async()=>{
  const order:string[]=[];let active=0,max=0;
  const run=async(id:string)=>{order.push(id);active++;max=Math.max(max,active);await Promise.resolve();active--;if(id==='calendar')throw new Error('fixture index unavailable');return {};};
  const prep=new StartupPreparation(fixture(run),()=>run('model'));
  await prep.run();assert.deepEqual(order,['mail','model','calendar','contacts']);assert.equal(max,1);
  assert.equal(prep.snapshot().tasks.calendar.state,'error');assert.equal(prep.snapshot().tasks.contacts.state,'ready');
});
test('interactive calls defer the next queued preparation and shutdown cancels queued work',async()=>{
  let active=1;const order:string[]=[];
  const prep=new StartupPreparation(fixture(async id=>{order.push(id);return {};},()=>active),async()=>({}),async()=>{active=0;});
  await prep.run();assert.equal(order[0],'mail');
  let wake!:()=>void;
  const stopped=new StartupPreparation(fixture(async id=>{throw new Error('must not run');},()=>1),async()=>({}),()=>new Promise(resolve=>{wake=resolve;}));
  const pending=stopped.run();stopped.stop();wake();await pending;
  assert.equal(stopped.snapshot().tasks.mail.state,'queued');
});
const gateway={baseUrl:'http://127.0.0.1:4000/v1',apiKey:'fixture-key'} as any;
test('model preparation only sends generic text to the local embedding route with attribution',async()=>{
  let calls=0;
  const fetcher=(async(url:any,options:any)=>{calls++;assert.equal(String(url),'http://127.0.0.1:4000/v1/embeddings');assert.equal(options.headers.authorization,'Bearer fixture-key');assert.equal(options.headers['x-usage-action'],'startup-embedding');assert.deepEqual(JSON.parse(options.body),{model:'local-embed',input:'Steward startup preparation.'});return new Response(JSON.stringify({data:[{embedding:[1,0]}]}));}) as typeof fetch;
  assert.deepEqual(await prepareLocalEmbedding(gateway,new AbortController().signal,fetcher,{}),{});
  assert.ok((await prepareLocalEmbedding(gateway,new AbortController().signal,fetcher,{MAIL_EMBED_ENDPOINT:'https://provider.example/v1/embeddings'})).skipped);
  assert.equal(calls,1);
});
test('model preparation surfaces missing models/auth errors without hiding ready connectors',async()=>{
  await assert.rejects(prepareLocalEmbedding(gateway,new AbortController().signal,async()=>new Response('',{status:401})),/HTTP 401/);
  await assert.rejects(prepareLocalEmbedding(gateway,new AbortController().signal,async()=>new Response('{"data":[]}')),/invalid vector/);
});

test('disabled embedding configuration does not load a model',async()=>{
  const result=await prepareLocalEmbedding(gateway,new AbortController().signal,async()=>{throw new Error('must not fetch');},{MAIL_EMBED_ENDPOINT:'off'});
  assert.ok(result.skipped);
});
