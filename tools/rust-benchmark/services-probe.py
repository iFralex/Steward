#!/usr/bin/env python3
import json,os,time,urllib.request,statistics
from pathlib import Path
from datetime import datetime,timezone
support=Path.home()/'Library/Application Support';root=Path(__file__).resolve().parents[2];token=(support/'Steward/auth-token').read_text().strip();config={}
for line in (support/'Steward/config.env').read_text().splitlines():
 if '=' not in line or line.lstrip().startswith('#'):continue
 k,v=line.strip().split('=',1);v=v.strip()
 try:v=json.loads(v) if v.startswith('"') else v.strip("'")
 except json.JSONDecodeError:continue
 config[k.strip()]=v
results={}
def measure(name,url,method='GET',data=None,credential=None,runs=4):
 elapsed=[];lengths=[];statuses=[];attributes=[]
 for i in range(runs):
  body=json.dumps(data).encode() if data is not None else None;headers={}
  if credential:headers['Authorization']='Bearer '+credential
  if body:headers['Content-Type']='application/json';headers['x-usage-service']='benchmark';headers['x-usage-action']='rust-migration-local-embed'
  req=urllib.request.Request(url,data=body,headers=headers,method=method);t=time.monotonic()
  try:
   with urllib.request.urlopen(req,timeout=90) as r:raw=r.read();status=r.status
   obj=json.loads(raw);info={'ok':obj.get('ok') if isinstance(obj,dict) else None}
   if name=='local_embedding':info['dimension']=len(obj.get('data',[{}])[0].get('embedding',[]));info['model']=obj.get('model')
  except Exception as e:raw=b'';status=0;info={'errorType':type(e).__name__}
  elapsed.append((time.monotonic()-t)*1000);lengths.append(len(raw));statuses.append(status);attributes.append(info)
 results[name]={'samplesMs':elapsed,'warmMedianMs':statistics.median(elapsed[1:]),'statuses':statuses,'responseBytes':lengths,'attributes':attributes}
for name,path in [('health','/health'),('system','/system/status'),('voice_status','/voice/status'),('audit','/audit?limit=3'),('usage_7','/usage?days=7'),('usage_30','/usage?days=30')]:
 print('Measuring '+name,flush=True);measure(name,'http://127.0.0.1:4317'+path,credential=token)
print('Measuring local embedding',flush=True);measure('local_embedding','http://127.0.0.1:4000/v1/embeddings','POST',{'model':'local-embed','input':'generic project planning'},config.get('GATEWAY_API_KEY'),3)
report={'utc':datetime.now(timezone.utc).isoformat(),'results':results,'method':'Real local HTTP endpoints, sequential first plus warm calls; local embedding sends only generic text to local-embed and adds free usage records. Response bodies, tokens, vectors and credentials are not saved. The model may already be warm.'};(root/'.local-evals/mcp-rust-benchmark/services.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
