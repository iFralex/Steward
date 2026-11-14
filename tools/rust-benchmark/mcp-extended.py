#!/usr/bin/env python3
import json,time,subprocess,statistics
from pathlib import Path
from datetime import datetime,timezone
src=Path(__file__).with_name('mcp-probe.py').read_text().split("with tempfile.TemporaryDirectory(prefix='steward-mcp-benchmark-') as temp:")[0];ns={'__file__':__file__};exec(compile(src,'mcp-probe-support','exec'),ns);Client=ns['Client'];trial=ns['trial'];root=ns['root']
def payload(r):
 contents=r.get('content',[])
 if r.get('isError') or not contents:raise ValueError('tool returned error or no content')
 return json.loads(contents[0]['text'])
results={}
for server in ['mail','calendar','contacts','action-center','llm-wiki','trains']:
 print('Extended '+server,flush=True);c=None;out={'tests':[]};results[server]=out
 try:
  c=Client(server)
  def call(tool,args):return payload(c.call('tools/call',{'name':tool,'arguments':args}))
  def measure(tool,args,runs=4):
   try:out['tests'].append(trial(c,tool,args,runs))
   except Exception as e:out['tests'].append({'tool':tool,'errorType':type(e).__name__})
  if server=='mail':
   found=call('search_messages',{'query':'project','limit':1,'perMessage':True}).get('messages',[])
   if found:
    m=found[0];measure('read_message',{'id':str(m['id']),'bodyLimit':1000});measure('get_thread',{'threadId':m['threadId'],'limit':3})
   for tool in ['list_scheduled','list_write_operations']:measure(tool,{})
   # vmmap reports process accounting, not individual private email data; store summaries only.
   p=subprocess.run(['vmmap','-summary',str(c.p.pid)],capture_output=True,text=True,timeout=30)
   out['memorySummary']=[line.strip() for line in p.stdout.splitlines() if 'Physical footprint' in line or 'phys_footprint' in line or 'TOTAL' in line][-8:];out['memorySummaryExitCode']=p.returncode
  elif server=='calendar':
   measure('list_calendars',{});found=call('search_events',{'limit':1}).get('events',[])
   if found:measure('read_event',{'uid':found[0]['uid'],'occurrenceStart':found[0]['occurrenceStart']})
  elif server=='contacts':
   found=call('search_contacts',{'query':'a','limit':1}).get('contacts',[])
   if found:measure('read_contact',{'uid':found[0]['uid']})
  elif server=='action-center':
   found=call('list_actions',{'status':'all','limit':1})
   if found:measure('read_action',{'id':found[0]['id']})
   measure('search_flows',{'query':'stewardbenchmarkabsent9e7318fd','limit':3})
  elif server=='llm-wiki':
   measure('llm_wiki_projects',{});measure('llm_wiki_files',{'project_id':'current','max_files':3});measure('llm_wiki_reviews',{'project_id':'current','limit':3})
   found=call('llm_wiki_files',{'project_id':'current','max_files':3})
   out['fileListShape']={k:type(v).__name__ for k,v in found.items()} if isinstance(found,dict) else type(found).__name__
  elif server=='trains':
   # One public, read-only lookup; response is discarded after extracting a possible opaque ref.
   r=c.call('tools/call',{'name':'find_next_train','arguments':{'from':'Milano Centrale','to':'Bologna Centrale'}},timeout=45);out['trainLookupIsError']=bool(r.get('isError'));out['trainResponseBytes']=len(json.dumps(r).encode())
   try:
    result=payload(r);ref=result.get('trainRef') if isinstance(result,dict) else None
    if ref:measure('train_status',{'trainRef':ref},2)
   except (ValueError,KeyError,TypeError):pass
 except Exception as e:out['errorType']=type(e).__name__
 finally:
  if c:c.close()
report={'utc':datetime.now(timezone.utc).isoformat(),'results':results,'method':'Installed MCP services, read-only calls; live train lookup contacts public ViaggiaTreno. Private tool responses and IDs are discarded. External latency depends on that service. vmmap summary may contain shared mappings; do not interpret RSS as unique RAM.'};(root/'.local-evals/mcp-rust-benchmark/mcp-extended.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
