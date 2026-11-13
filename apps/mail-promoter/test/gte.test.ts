import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../mail-mirror/src/store.ts";
import { PromoteState } from "../src/state.ts";
import { processThread, runBatch, type RunDeps } from "../src/run.ts";
import { GteGate, type GateDecision } from "../src/gte.ts";
import { GatewayChatError } from "../src/llm.ts";
import { BatchControl } from "../src/batch-control.ts";
import { buildGteInput } from "../src/gte-input.ts";
import { buildThreadInput } from "../src/thread-input.ts";

const negative: GateDecision = { route: "discard", reason: "scored", score: .01, threshold: .05, tokens: 100 };
function setup(decision = negative) {
  const store=Store.open(":memory:");const state=PromoteState.open(":memory:");
  const message = { messageId:"m1",account:"A",mailbox:"INBOX",fromName:"Anna",fromAddr:"anna@x.test",
    to:["me@x.test"],cc:[],toNames:[],ccNames:[],subject:"Subject",date:1750000000,bodyText:"Body",bodyState:"full" as const,
    source:"emlx" as const,emlxPath:null,inReplyTo:null,references:[],gmThrid:null,size:1,unread:false,flagged:false,answered:false,junk:false,flagColor:null,appleThrid:null };
  store.upsertMessage(message);store.setThreadId("m1",1);
  const calls={gte:0,llm:0};
  const deps:RunDeps={store,state,userAddrs:["me@x.test"],roleOf:()=>"inbox",accountLabelOf:()=>"account",
    wiki:{addSources:async()=>({})},chat:async()=>{calls.llm++;return '{"promoteMail":false,"note":null}';},
    gate:{modelId:"model-v1",check:async()=>{calls.gte++;return decision;},close:()=>{}}};
  return {deps,calls,message};
}

test("GTE discard is cached separately and never becomes an LLM training label",async()=>{
  const {deps,calls}=setup();
  assert.equal(await processThread(deps,1),"gated");
  assert.equal(await processThread(deps,1),"gated");
  assert.deepEqual(calls,{gte:1,llm:0});assert.equal(deps.state.get("thread:1"),undefined);
  deps.gate={...deps.gate!,modelId:"model-v2"};
  assert.equal(await processThread(deps,1),"gated");assert.equal(calls.gte,2);
  deps.state.close();deps.store.close();
});

test("changing content or user participation invalidates GTE cache",async()=>{
  const {deps,calls,message}=setup();await processThread(deps,1);
  deps.userAddrs=[];await processThread(deps,1);
  deps.store.upsertMessage({...message,bodyText:"New body"});await processThread(deps,1);
  assert.equal(calls.gte,3);deps.state.close();deps.store.close();
});

test("a new attachment bypasses even an existing negative GTE cache",async()=>{
  const {deps,calls}=setup();await processThread(deps,1);
  deps.store.raw.prepare("INSERT INTO attachments(message_id,filename,mime,size,sha256) VALUES(?,?,?,?,?)").run("m1","document.pdf","application/pdf",10,"a".repeat(64));
  assert.equal(await processThread(deps,1),"skipped");
  assert.deepEqual(calls,{gte:1,llm:1});deps.state.close();deps.store.close();
});

test("GTE never deletes an existing canonical note or rewrites teacher state",async()=>{
  const {deps}=setup();deps.state.record({messageId:"thread:1",decision:"promoted",categories:["commitment"],classifyModel:"tier-5",distillModel:"tier-5",wikiFilename:"note.md",sourceHash:"old"});
  assert.equal(await processThread(deps,1),"gated");assert.equal(deps.state.getRecord("thread:1")?.sourceHash,"old");assert.equal(deps.state.getRecord("thread:1")?.wikiFilename,"note.md");
  deps.state.close();deps.store.close();
});

test("overflow and inference exceptions forward to normal triage",async()=>{
  for(const variant of ["overflow","throw"]) {
    const {deps,calls}=setup({route:"llm",reason:"context_overflow",tokens:9000});
    if(variant==="throw")deps.gate!.check=async()=>{throw new Error("local model failed");};
    assert.equal(await processThread(deps,1),"skipped");assert.equal(calls.llm,1);deps.state.close();deps.store.close();
  }
});

test("a failed remote triage reuses a cached positive GTE score",async()=>{
  const {deps,calls}=setup({route:"llm",reason:"scored",score:.5,threshold:.05,tokens:100});
  deps.chat=async()=>{calls.llm++;return "not valid JSON";};
  assert.equal(await processThread(deps,1),"deferred");
  assert.equal(await processThread(deps,1),"deferred");
  assert.deepEqual(calls,{gte:1,llm:2});deps.state.close();deps.store.close();
});

test("budget-only deferrals do not create a per-thread failure backoff",async()=>{
  const {deps}=setup({route:"llm",reason:"scored",score:.5,threshold:.05,tokens:100});
  const control=deps.control=new BatchControl(deps.state,{maxGateScores:10,maxGatewayCalls:1,gatewayKey:"test-budget"});
  const wrapped=control.wrap(deps.chat);await wrapped("s","u");deps.chat=wrapped;
  assert.equal(await processThread(deps,1),"deferred");
  assert.equal(deps.state.runtime("triage-retry:1"),undefined);deps.state.close();deps.store.close();
});

test("GTE serialization preserves the evaluated untruncated full-thread format",()=>{
  const {deps}=setup();const input=buildThreadInput(deps.store,1)!;
  const day=new Date(input.date*1000).toISOString().slice(0,10);
  assert.equal(buildGteInput(input,["ME@X.TEST"],input.date),`Decision date: ${day}\nSubject: Subject\n\n--- ${day}; user is recipient; from Anna <anna@x.test> ---\nBody`);
  deps.state.close();deps.store.close();
});

test("batch gate budget leaves work pending and gateway budget bounds requests",async()=>{
  const {deps,calls,message}=setup();const control=new BatchControl(deps.state,{maxGateScores:1,maxGatewayCalls:1,gatewayKey:"test"});deps.control=control;
  await processThread(deps,1);deps.store.upsertMessage({...message,messageId:"m2"});deps.store.setThreadId("m2",2);
  assert.equal(await processThread(deps,2),"deferred");assert.equal(calls.gte,1);
  const chat=control.wrap(deps.chat);await chat("s","u");await assert.rejects(()=>chat("s","u"),/batch limit/);
  assert.equal(calls.llm,1);deps.state.close();deps.store.close();
});

test("global backoff persists across batches and permits a later probe",async()=>{
  const state=PromoteState.open(":memory:");let now=1000;let calls=0;
  const config={maxGateScores:10,maxGatewayCalls:10,gatewayKey:"provider",now:()=>now};
  const failed=async()=>{calls++;throw new GatewayChatError(402);};
  const first=new BatchControl(state,config);await assert.rejects(()=>first.wrap(failed)("s","u"));
  const next=new BatchControl(state,config);await assert.rejects(()=>next.wrap(failed)("s","u"),/backoff/);assert.equal(calls,1);
  now=first.backoff!.until+1;await assert.rejects(()=>next.wrap(failed)("s","u"));assert.equal(calls,2);assert.equal(next.backoff!.failures,2);state.close();
});

test("a batch of fast cached/unchanged threads still services child-process I/O",async()=>{
  const {deps,message}=setup();
  for(let i=2;i<=80;i++) {deps.store.upsertMessage({...message,messageId:"m"+i});deps.store.setThreadId("m"+i,i);}
  const stateNeeds=deps.state.needsProcessing.bind(deps.state);deps.state.needsProcessing=()=>false;
  let ioServiced=false;setImmediate(()=>{ioServiced=true;});
  const tally=await runBatch(deps,{concurrency:4});
  assert.equal(tally.skipped,80);assert.equal(ioServiced,true);
  deps.state.needsProcessing=stateNeeds;deps.state.close();deps.store.close();
});

test("worker protocol errors and timeouts cannot discard a message",async()=>{
  const folder=mkdtempSync(join(tmpdir(),"mail-gte-test-"));
  try {
    const manifest=join(folder,"manifest.json");const raw=JSON.stringify({threshold:.05,maxTokens:8192,policyHash:"a".repeat(64)});writeFileSync(manifest,raw);
    const id=createHash("sha256").update(raw).digest("hex");
    for(const variant of ["timeout","invalid","reason"]) {
      const worker=join(folder,variant+".cjs");
      writeFileSync(worker,`console.log(JSON.stringify({ready:true,modelId:${JSON.stringify(id)}}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);${variant!=='timeout'?`console.log(JSON.stringify({id:r.id,modelId:${JSON.stringify(id)},route:'discard',reason:'${variant==='invalid'?'scored':'inference_error'}',score:${variant==='invalid'?'.9':'.01'},threshold:.05,tokens:100}));`:''}});`);
      const gate=new GteGate({python:process.execPath,worker,manifest,timeoutMs:100,startupMs:3000});
      try{const result=await gate.check("body","a".repeat(64));assert.equal(result.route,"llm");assert.equal((await gate.check("body","a".repeat(64))).route,"llm");}finally{gate.close();}
    }
  }finally{rmSync(folder,{recursive:true,force:true});}
});
