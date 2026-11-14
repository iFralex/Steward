#!/usr/bin/env python3
import json,subprocess,time,statistics,re
from pathlib import Path
root=Path(__file__).resolve().parents[2];d=root/'.local-evals/rust-benchmark';data=d/'groups.bin';meta=json.loads(Path(str(data)+'.json').read_text());cutoff=str(meta['cutoff']);node=subprocess.check_output(['which','node'],text=True).strip();cases={'node':[node,str(root/'tools/rust-benchmark/groups.mjs'),str(data),cutoff],'rust':[str(d/'groups-rust'),str(data),cutoff]};samples={k:[] for k in cases};outputs={}
for run in range(4):
 for name in (['node','rust'] if run%2==0 else ['rust','node']):
  start=time.monotonic();p=subprocess.run(['/usr/bin/time','-l',*cases[name]],capture_output=True,text=True,check=True);duration=time.monotonic()-start
  rss=next(int(line.strip().split()[0]) for line in p.stderr.splitlines() if 'maximum resident set size' in line);cpu=re.search(r'([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys',p.stderr);assert cpu;out=json.loads(p.stdout)
  if name in outputs:assert out==outputs[name], 'Nondeterministic results'
  outputs[name]=out;samples[name].append({'wallSeconds':duration,'userCpuSeconds':float(cpu.group(2)),'systemCpuSeconds':float(cpu.group(3)),'peakRssBytes':rss})
a,b=outputs['node'],outputs['rust'];assert a['count']==b['count']==meta['count'];maxdiff=0
for x,y in zip(a['groups'],b['groups'],strict=True):
 assert len(x)==len(y)
 for row1,row2 in zip(x,y,strict=True):
  assert row1[:-1]==row2[:-1],(row1,row2);maxdiff=max(maxdiff,abs(row1[-1]-row2[-1]))
assert maxdiff<1e-9
summary={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'records':a['count'],'inputBytes':meta['bytes'],'groupsPerDimension':[len(g) for g in a['groups']],'dayCutoffUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(meta['cutoff']/1000)),'samples':samples,'medianWallSeconds':{k:statistics.median(x['wallSeconds'] for x in v) for k,v in samples.items()},'medianCpuSeconds':{k:statistics.median(x['userCpuSeconds']+x['systemCpuSeconds'] for x in v) for k,v in samples.items()},'medianPeakRssBytes':{k:statistics.median(x['peakRssBytes'] for x in v) for k,v in samples.items()},'equalIntegerFields':True,'maxGroupCostDifferenceUsd':maxdiff,'method':'Four alternating process runs including startup and buffered reads. Five group dimensions use anonymized IDs and precomputed local day; sums include token counters and costs. Same snapshot/order and cutoff; OS cache not controlled. Excludes SQLite access, date formatting, other Usage fields, worker and HTTP.'}
(d/'group-comparison.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
