#!/usr/bin/env python3
import json
from pathlib import Path
source=Path(__file__).with_name('mcp-probe.py').read_text().split("with tempfile.TemporaryDirectory(prefix='steward-mcp-benchmark-') as temp:")[0]
ns={'__file__':__file__};exec(compile(source,'mcp-probe-support','exec'),ns);Client=ns['Client']
def shape(x,depth=0):
 if depth>5:return '…'
 if isinstance(x,dict):return {k:shape(v,depth+1) for k,v in x.items()}
 if isinstance(x,list):return {'length':len(x),'sample':shape(x[0],depth+1) if x else None}
 return type(x).__name__
for server,tool,args in [('mail','search_messages',{'query':'project','limit':1,'perMessage':True}),('calendar','search_events',{'limit':1}),('contacts','search_contacts',{'query':'a','limit':1}),('action-center','list_actions',{'status':'all','limit':1}),('llm-wiki','llm_wiki_files',{'project_id':'current','limit':1})]:
 c=None
 try:
  c=Client(server);r=c.call('tools/call',{'name':tool,'arguments':args});contents=r.get('content',[]);payload=json.loads(contents[0]['text']) if contents and contents[0].get('type')=='text' else r
  print(json.dumps({'server':server,'tool':tool,'isError':r.get('isError',False),'shape':shape(payload)},ensure_ascii=False))
 except Exception as e:print(json.dumps({'server':server,'errorType':type(e).__name__}))
 finally:
  if c:c.close()
