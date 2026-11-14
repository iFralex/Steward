#!/usr/bin/env python3
"""Measure installed MCP servers. Save only timings, sizes and status, never tool results."""
import json,os,selectors,subprocess,time,statistics,tempfile,shlex
from pathlib import Path
from datetime import datetime,timezone
root=Path(__file__).resolve().parents[2];support=Path.home()/'Library/Application Support';resources=Path('/Applications/Steward.app/Contents/Resources');node=resources/'node/bin/node';env=os.environ.copy();env.update({'NODE_ENV':'production','NODE_PATH':str(resources/'node_modules'),'LLM_WIKI_ROOT':str(resources),'LLM_WIKI_NODE':str(node),'LLM_WIKI_BUNDLED_SERVICES':'1','STEWARD_CALENDAR_BRIDGE_DIR':str(support/'Steward/calendar-bridge')})
for line in (support/'Steward/config.env').read_text().splitlines():
 line=line.strip()
 if not line or line.startswith('#') or '=' not in line:continue
 key,value=line.split('=',1);key=key.strip();value=value.strip()
 try:value=json.loads(value) if value.startswith('"') else (value[1:-1] if len(value)>=2 and value[0]==value[-1]=="'" else value)
 except json.JSONDecodeError:raise RuntimeError('Cannot parse configuration entry '+key)
 env[key]=str(value)
# The measured paths use only local embedding; never route benchmark text to a paid provider.
env.update({'MAIL_EMBED_ENDPOINT':'http://127.0.0.1:4000/v1/embeddings','MAIL_EMBED_MODEL':'local-embed','DOCUMENT_EMBED_ENDPOINT':'http://127.0.0.1:4000/v1/embeddings','DOCUMENT_EMBED_MODEL':'local-embed','ACTION_FLOW_EMBED_ENDPOINT':'http://127.0.0.1:4000/v1/embeddings','ACTION_FLOW_EMBED_MODEL':'local-embed'})
state=json.loads((support/'com.llmwiki.app/app-state.json').read_text());env.setdefault('LLM_WIKI_API_TOKEN',state.get('apiConfig',{}).get('token',''))
class Client:
 def __init__(self,name):
  self.n=0;self.buffer=b'';self.selector=selectors.DefaultSelector();start=time.monotonic();self.p=subprocess.Popen([str(node),str(resources/'services/mcp'/f'{name}.js')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,cwd=root);self.selector.register(self.p.stdout,selectors.EVENT_READ)
  self.call('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'steward-read-benchmark','version':'1'}});self.notify('notifications/initialized',{});self.startup=time.monotonic()-start
 def notify(self,method,params):self.p.stdin.write((json.dumps({'jsonrpc':'2.0','method':method,'params':params})+'\n').encode());self.p.stdin.flush()
 def call(self,method,params,timeout=90):
  self.n+=1;request={'jsonrpc':'2.0','id':self.n,'method':method,'params':params};self.p.stdin.write((json.dumps(request)+'\n').encode());self.p.stdin.flush();deadline=time.monotonic()+timeout
  while time.monotonic()<deadline:
   while b'\n' in self.buffer:
    line,self.buffer=self.buffer.split(b'\n',1)
    try:message=json.loads(line)
    except (ValueError,UnicodeError):continue
    if message.get('id')==self.n:
     if 'error' in message:raise RuntimeError('MCP JSON-RPC error '+str(message['error'].get('code')))
     return message['result']
   if not self.selector.select(max(0,deadline-time.monotonic())):break
   chunk=os.read(self.p.stdout.fileno(),65536)
   if not chunk:raise RuntimeError('MCP process exited')
   self.buffer+=chunk
  raise TimeoutError('MCP request timed out')
 def close(self):
  self.p.terminate()
  try:self.p.wait(timeout=5)
  except subprocess.TimeoutExpired:self.p.kill();self.p.wait()
  self.selector.close()
 def rss(self):
  try:return int(subprocess.check_output(['ps','-o','rss=','-p',str(self.p.pid)],text=True).strip())*1024
  except Exception:return None

def trial(client,tool,args,runs=4):
 samples=[];sizes=[];errors=0
 for _ in range(runs):
  start=time.monotonic();r=client.call('tools/call',{'name':tool,'arguments':args});samples.append((time.monotonic()-start)*1000);sizes.append(len(json.dumps(r,ensure_ascii=False).encode()));errors+=bool(r.get('isError'))
 warm=sorted(samples[1:]);return {'tool':tool,'samplesMs':samples,'firstMs':samples[0],'warmMedianMs':statistics.median(warm),'warmMaxMs':max(warm),'responseBytes':sizes,'toolErrors':errors,'rssBytesAfter':client.rss()}
with tempfile.TemporaryDirectory(prefix='steward-mcp-benchmark-') as temp:
 doc=Path(temp)/'synthetic.txt';doc.write_text(('Generic project planning and retrieval. benchmarktarget is a synthetic fact.\n'*1600))
 cases={
 'mail':[('search_messages',{'query':'project','limit':3}),('search_messages',{'subjectContains':'stewardbenchmarkabsent9e7318fd','limit':3})],
 'calendar':[('search_events',{'query':'project','limit':3}),('search_events',{'start':'2100-01-01T00:00:00+01:00','end':'2100-01-02T00:00:00+01:00','limit':3})],
 'contacts':[('search_contacts',{'query':'project','limit':3}),('resolve_recipient',{'description':'stewardbenchmarkabsent9e7318fd','limit':3})],
 'documents':[('document_info',{'path':str(doc)}),('document_read',{'path':str(doc),'max_chars':1000}),('document_search',{'path':str(doc),'query':'benchmarktarget','max_results':3})],
 'shell':[('run_command',{'command':'wc -l '+str(doc)}),('find_files',{'root':temp,'name':'stewardbenchmarkabsent9e7318fd','limit':3})],
 'action-center':[('list_actions',{'status':'open','limit':3}),('list_flows',{})],
 'llm-wiki':[('llm_wiki_status',{}),('llm_wiki_search',{'query':'stewardbenchmarkabsent9e7318fd','top_k':3})],
 # Live rail lookup uses an external service; run only when explicitly opted in.
 'trains':[]}
 results={}
 for name,entries in cases.items():
  print('Measuring '+name,flush=True);client=None
  try:
   client=Client(name);tools=client.call('tools/list',{}).get('tools',[]);names={x['name'] for x in tools};record={'startupSeconds':client.startup,'toolCount':len(names),'toolNames':sorted(names),'tests':[]};results[name]=record
   for tool,args in entries:
    if tool not in names:record['tests'].append({'tool':tool,'error':'not listed'});continue
    try:record['tests'].append(trial(client,tool,args))
    except Exception as e:record['tests'].append({'tool':tool,'errorType':type(e).__name__})
  except Exception as e:results[name]={'startupFailure':type(e).__name__}
  finally:
   if client:client.close()
report={'utc':datetime.now(timezone.utc).isoformat(),'results':results,'method':'Fresh installed MCP process per server. One initial call and three sequential warm calls per read tool; local BGE embeddings may add zero-cost gateway ledger rows. No returned payload or personal identifiers saved. No writes, sends, provider-paid LLM calls or external train requests. RSS excludes child processes and GPU allocations. Not the existing host process or full chat latency.'}
output=root/'.local-evals/mcp-rust-benchmark/mcp-results.json';output.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
