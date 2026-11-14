#!/usr/bin/env python3
import json,os,select,statistics,subprocess,time
from pathlib import Path
from datetime import datetime,timezone
root=Path(__file__).resolve().parents[2];release=root/'.local-models/mail-gate/releases/2026-11-12-gte-v1-r2';config=json.loads((release/'manifest.json').read_text());python=root/'.local-models/mail-gate/venv/bin/python';worker=release/'gte_worker.py';start=time.monotonic();p=subprocess.Popen([str(python),str(worker),'--manifest',str(release/'manifest.json')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
def readline(timeout=180):
 if not select.select([p.stdout],[],[],timeout)[0]:raise TimeoutError('GTE timed out')
 line=p.stdout.readline()
 if not line:raise RuntimeError('GTE exited before response')
 return json.loads(line)
def rss():
 try:return int(subprocess.check_output(['ps','-o','rss=','-p',str(p.pid)],text=True).strip())*1024
 except Exception:return None
try:
 ready=readline();startup=time.monotonic()-start
 if not ready.get('ready'):raise RuntimeError('GTE not ready')
 results=[];request_id=0
 for repeats,runs in [(100,3),(500,3),(2000,2),(4000,2),(7900,1)]:
  # The full input is synthetic and stays local; actual tokenizer counts are in each response.
  text='Subject: Project update\n\n'+('project '*repeats);times=[];tokens=[];reasons=[]
  print('GTE input words='+str(repeats),flush=True)
  for _ in range(runs):
   request_id+=1;t=time.monotonic();p.stdin.write(json.dumps({'id':request_id,'policyHash':config['policyHash'],'text':text})+'\n');p.stdin.flush();result=readline();times.append(time.monotonic()-t);tokens.append(result.get('tokens'));reasons.append(result.get('reason'))
  results.append({'inputWordRepetitions':repeats,'tokens':tokens,'reason':reasons,'seconds':times,'medianSeconds':statistics.median(times),'rssBytesAfter':rss()})
 report={'utc':datetime.now(timezone.utc).isoformat(),'startupSeconds':startup,'backend':ready.get('backend'),'results':results,'method':'Actual deployed GTE worker and manifest, synthetic generic text, single worker, MPS, other services active. First inference at each bucket is included; no network or paid model. RSS excludes GPU allocations; unified-memory peak is not measured.'};(root/'.local-evals/mcp-rust-benchmark/gte.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
finally:
 p.terminate()
 try:p.wait(timeout=10)
 except subprocess.TimeoutExpired:p.kill();p.wait()
