#!/usr/bin/env python3
import json,os,subprocess,time,statistics,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[2];data=root/'.local-evals/rust-benchmark/records.bin';binary=root/'.local-evals/rust-benchmark/totals-rust';node=subprocess.check_output(['which','node'],text=True).strip();cases={'node':[node,str(root/'tools/rust-benchmark/totals.mjs'),str(data)],'rust':[str(binary),str(data)]};results={k:[] for k in cases};outputs={}
for j in range(4):
 for name in (['node','rust'] if j%2==0 else ['rust','node']):
  start=time.monotonic();p=subprocess.run(['/usr/bin/time','-l',*cases[name]],capture_output=True,text=True,check=True);wall=time.monotonic()-start
  rss=next(int(line.strip().split()[0]) for line in p.stderr.splitlines() if 'maximum resident set size' in line);out=json.loads(p.stdout);outputs.setdefault(name,out)
  assert out==outputs[name], 'Output changed between repetitions';results[name].append({'wallSeconds':wall,'peakRssBytes':rss})
a,b=outputs['node'],outputs['rust'];assert all(a[k]==b[k] for k in ['calls','input','output','cacheRead','cacheWrite']);assert abs(a['cost']-b['cost'])<1e-9
summary={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'inputBytes':data.stat().st_size,'samples':results,'output':a,'equality':'integer fields exact; cost within 1e-9 USD','medianWallSeconds':{k:statistics.median(x['wallSeconds'] for x in v) for k,v in results.items()},'medianPeakRssBytes':{k:statistics.median(x['peakRssBytes'] for x in v) for k,v in results.items()},'method':'Four alternating runs including startup and buffered file reads, same ordered numeric snapshot; OS cache not controlled. Not the complete Usage aggregation or a database benchmark.'}
(root/'.local-evals/rust-benchmark/comparison.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
