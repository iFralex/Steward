#!/usr/bin/env python3
import concurrent.futures,json,time,urllib.request,os,subprocess
from pathlib import Path
from datetime import datetime,timezone
root=Path(__file__).resolve().parents[2];token=(Path.home()/'Library/Application Support/Steward/auth-token').read_text().strip()
def request(path):
 t=time.monotonic();req=urllib.request.Request('http://127.0.0.1:4317'+path,headers={'Authorization':'Bearer '+token});
 with urllib.request.urlopen(req,timeout=180) as response: value=json.load(response)
 return time.monotonic()-t,value
with concurrent.futures.ThreadPoolExecutor() as pool:
 task=pool.submit(request,'/usage?days=1234567');health=[]
 while not task.done(): health.append(request('/health')[0]);time.sleep(.5)
 elapsed,data=task.result()
cache,_=request('/usage?days=1234567');status,_=request('/system/status')
ps=subprocess.check_output(['ps','-axo','pid=,ppid=,rss=,%cpu=,args='],text=True);processes=[]
for line in ps.splitlines():
 parts=line.strip().split(maxsplit=4)
 if len(parts)<5:continue
 pid,ppid,rss,cpu,args=parts
 for name,pattern in [('host','/services/host/index.js'),('gateway','/services/llm-gateway/gateway.js'),('scheduler','/services/scheduler/index.js'),('mcp','/services/mcp/'),('launcher','/MacOS/StewardLauncher'),('wiki','/MacOS/llm-wiki'),('gte','/gte_worker.py')]:
  if pattern in args and not ('/bin/bash -c' in args):processes.append({'pid':int(pid),'parent':int(ppid),'type':name,'rssKiB':int(rss),'cpuPercent':float(cpu)});break
result={'utc':datetime.now(timezone.utc).isoformat(),'usageSeconds':elapsed,'usageCachedSeconds':cache,'systemStatusSeconds':status,'healthChecks':len(health),'healthMaxSeconds':max(health,default=0),'calls':data['totals']['calls'],'processSnapshot':processes,'rssCaveat':'RSS includes shared pages; process sums overcount shared memory; CPU is a momentary ps sample.'};(root/'.local-evals/rust-benchmark/live-baseline.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
