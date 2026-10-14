import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer, type Server} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

process.env.USAGE_DIR=mkdtempSync(join(tmpdir(),'gateway-deadline-'));
process.env.GATEWAY_REQUEST_TIMEOUT_MS='200';
const listen=async(server:Server)=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return (server.address() as {port:number}).port;};
const close=async(server:Server)=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};

test('fallback shares the original deadline including upstream body consumption',async()=>{
  let calls=0;
  const provider=createServer((_req,res)=>{
    calls++;
    if(calls===1)setTimeout(()=>{res.writeHead(503);res.end('try another model');},120);
    else {res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();} // body never completes
  });
  process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${await listen(provider)}/v1`;
  const {startGateway}=await import('../src/gateway.ts');
  const gateway=startGateway(0);
  await new Promise<void>(resolve=>gateway.once('listening',resolve));
  try {
    const started=Date.now();
    const response=await fetch(`http://127.0.0.1:${(gateway.address() as {port:number}).port}/v1/chat/completions`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'tier-5',messages:[]})});
    assert.equal(response.status,502);
    await response.text();
    assert.equal(calls,2);
    assert.ok(Date.now()-started<1000,'stalled body must terminate within the shared budget');
  } finally {await close(gateway);await close(provider);}
});

test('a visible stalled native stream terminates without a synthetic resend',async()=>{
  let calls=0;
  const provider=createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"visible"}}]}\n\n');});
  process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${await listen(provider)}/v1`;
  const {startGateway}=await import('../src/gateway.ts');
  const gateway=startGateway(0);
  await new Promise<void>(resolve=>gateway.once('listening',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${(gateway.address() as {port:number}).port}/v1/chat/completions`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'tier-5',messages:[],stream:true})});
    assert.equal(response.status,200);
    const reader=response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value),/visible/);
    await assert.rejects(async()=>{while(!(await reader.read()).done){};});
    assert.equal(calls,1,'committed stream must never be replaced by another provider request');
  } finally {await close(gateway);await close(provider);}
});

test('model routes reject missing or wrong bearer keys before contacting the provider',async()=>{
  const previous=process.env.GATEWAY_API_KEY;
  process.env.GATEWAY_API_KEY='fixture-private-key';
  let calls=0;
  const provider=createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'});res.end('{"choices":[]}');});
  process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${await listen(provider)}/v1`;
  const {startGateway}=await import('../src/gateway.ts');
  const gateway=startGateway(0);
  await new Promise<void>(resolve=>gateway.once('listening',resolve));
  const url=`http://127.0.0.1:${(gateway.address() as {port:number}).port}`;
  try {
    for(const authorization of [undefined,'Bearer wrong']) {
      const response=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(authorization?{authorization}:{})},body:JSON.stringify({model:'tier-5',messages:[]})});
      assert.equal(response.status,401);await response.text();
    }
    assert.equal(calls,0);
    const response=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-private-key'},body:JSON.stringify({model:'tier-5',messages:[]})});
    assert.equal(response.status,200);await response.text();assert.equal(calls,1);
    const health=await fetch(url+'/health');assert.equal(health.status,200);await health.text();
  } finally {
    await close(gateway);await close(provider);
    if(previous===undefined)delete process.env.GATEWAY_API_KEY;else process.env.GATEWAY_API_KEY=previous;
  }
});
