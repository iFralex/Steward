#!/usr/bin/env python3
import json,re,time
from pathlib import Path
from datetime import datetime,timezone
src=Path(__file__).with_name('mcp-probe.py').read_text().split("with tempfile.TemporaryDirectory(prefix='steward-mcp-benchmark-') as temp:")[0]
src=src.replace("raise RuntimeError('MCP JSON-RPC error '+str(message['error'].get('code')))","raise RuntimeError('MCP '+str(message['error'].get('code'))+' '+str(message['error'].get('message','')))")
ns={'__file__':__file__};exec(compile(src,'mcp-probe-support','exec'),ns);Client=ns['Client'];results=[]
for server,tool,args in [('llm-wiki','llm_wiki_files',{'project_id':'current','max_files':3}),('llm-wiki','llm_wiki_files',{'project_id':'current'}),('trains','find_next_train',{'from':'Milano Centrale','to':'Bologna Centrale'})]:
 c=None;t=time.monotonic()
 try:
  c=Client(server);r=c.call('tools/call',{'name':tool,'arguments':args},timeout=45);results.append({'server':server,'tool':tool,'elapsedSeconds':time.monotonic()-t,'ok':not r.get('isError',False),'responseBytes':len(json.dumps(r).encode())})
 except Exception as e:
  message=str(e);message=re.sub(r'/Users/[^\s,;]+','[local-path]',message);message=re.sub(r'https?://[^\s,;]+','[url]',message)
  results.append({'server':server,'tool':tool,'elapsedSeconds':time.monotonic()-t,'errorType':type(e).__name__,'error':message[:200]})
 finally:
  if c:c.close()
report={'utc':datetime.now(timezone.utc).isoformat(),'results':results};(ns['root']/'.local-evals/mcp-rust-benchmark/mcp-errors.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
