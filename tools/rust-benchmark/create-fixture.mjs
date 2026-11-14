import Database from 'better-sqlite3';import{UsageLedger}from'../../.local-models/sqlite-runtime/tests/usage-ledger.mjs';
const db=new Database(process.argv[2]);const ledger=new UsageLedger(db);const now=1794500000000;
if(process.argv[3]!=='empty'){
for(let i=0;i<43;i++)db.prepare('INSERT INTO llm_calls(ts,service,action,model,tier,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,duration_ms,ok,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(now-i*86400000,i%2?'mail🧪':'host',i%3?'triage"':'chat',i%4?'m1':null,i%5?'tier-5':null,i,i%7,i%11,0,i%5/1000,100+i,i%2,200);
db.prepare('INSERT INTO tool_calls(ts,session_id,tool,duration_ms,ok) VALUES(?,?,?,?,?)').run(now,'sid','tool"🧪',12,1);db.prepare('INSERT INTO tool_calls(ts,session_id,tool,duration_ms,ok) VALUES(?,?,?,?,?)').run(now-86400000,'sid','tool"🧪',9,0);
ledger.recordVoiceCall({ts:now,sessionId:'s"1',transport:'ringback',outcome:'completed',durationMs:100,ok:true});ledger.recordProviderAttempt({ts:now,requestId:'req1',service:'host',action:'chat',model:'m',status:200,durationMs:40,stream:false});ledger.recordProviderAttempt({ts:now-1,requestId:'req2',service:'host',action:'chat',model:'m',status:200,durationMs:41,stream:true});}
db.close();
