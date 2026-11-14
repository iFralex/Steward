#!/usr/bin/env python3
import json,math,os,re,statistics,subprocess,sys,time
from pathlib import Path
root=Path(__file__).resolve().parents[2];local=root/'.local-evals/rust-benchmark';path=Path(sys.argv[1]);now=sys.argv[2];days=sys.argv[3] if len(sys.argv)>3 else 'all';repeat=int(sys.argv[4]) if len(sys.argv)>4 else 1
common=[str(path),now,days];env={**os.environ,'STEWARD_SQLITE_RUNTIME_TEST':'1'}
cases={'node': ['node','--import',str(root/'tools/sqlite-runtime-preload.mjs'),str(local/'summary-node-original.mjs'),*common],'node_optimized':['node','--import',str(root/'tools/sqlite-runtime-preload.mjs'),str(local/'summary-node-optimized.mjs'),*common],'rust':[str(local/'summary-rust'),*common]}
keys={'byService':('service',),'byAction':('service','action'),'byModel':('model',),'byTier':('tier',),'byDay':('day','service'),'byTool':('tool',),'byVoiceOutcome':('outcome',)}
def normalize(v):
 return v
def compare(a,b,path='root'):
 if isinstance(a,dict):
  assert isinstance(b,dict) and a.keys()==b.keys(),(path,'keys');[compare(a[k],b[k],path+'.'+k) for k in a]
 elif isinstance(a,list):
  assert isinstance(b,list) and len(a)==len(b),(path,'length');[compare(x,y,f'{path}[{i}]') for i,(x,y) in enumerate(zip(a,b))]
 elif isinstance(a,int) and not isinstance(a,bool) and isinstance(b,int) and not isinstance(b,bool):
  assert a==b,(path,a,b)
 elif isinstance(a,(float,int)) and not isinstance(a,bool):
  assert isinstance(b,(int,float)) and not isinstance(b,bool) and math.isclose(a,b,rel_tol=1e-12,abs_tol=1e-9),(path,a,b)
 else:assert a==b,(path,a,b)
outputs={};measure={k:[] for k in cases}
for run in range(repeat):
 for name in (list(cases) if run%2==0 else list(reversed(cases))):
  print(f'run={run+1}/{repeat} implementation={name}',file=sys.stderr,flush=True)
  t=time.monotonic();p=subprocess.run(['/usr/bin/time','-l',*cases[name]],cwd=root,env=env,text=True,capture_output=True)
  if p.returncode:raise RuntimeError(name+' failed: '+p.stderr[-1500:])
  out=normalize(json.loads(p.stdout));rss=next(int(x.strip().split()[0]) for x in p.stderr.splitlines() if 'maximum resident set size' in x);cpu=re.search(r'([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys',p.stderr);assert cpu
  if name in outputs:compare(outputs[name],out)
  outputs[name]=out;measure[name].append({'wallSeconds':time.monotonic()-t,'cpuSeconds':float(cpu.group(2))+float(cpu.group(3)),'peakRssBytes':rss})
compare(outputs['node'],outputs['node_optimized']);compare(outputs['node'],outputs['rust']);report={'snapshotBytes':path.stat().st_size,'nowMs':int(now),'days':days,'runs':repeat,'llmRows':outputs['node']['totals']['calls'],'fieldCounts':{k:len(outputs['node'][k]) for k in keys},'equal':True,'comparison':'All summary fields compared recursively, Array ordering preserved; integer values exact, floating values within 1e-9 absolute or 1e-12 relative.','samples':measure,'medianWallSeconds':{k:statistics.median(x['wallSeconds'] for x in v) for k,v in measure.items()},'medianCpuSeconds':{k:statistics.median(x['cpuSeconds'] for x in v) for k,v in measure.items()},'medianPeakRssBytes':{k:statistics.median(x['peakRssBytes'] for x in v) for k,v in measure.items()}}
if repeat>1:(local/('summary-comparison-'+days+'.json')).write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
