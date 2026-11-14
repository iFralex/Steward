#!/usr/bin/env python3
import json,re,statistics
from pathlib import Path
from datetime import datetime,timedelta,timezone
p=Path.home()/'Library/Logs/Steward/scheduler.log';cut=datetime.now(timezone.utc)-timedelta(hours=24);groups={};pattern=re.compile(r'^(\S+) \[([^\]]+)\] (ok|failed) \(([0-9]+)ms\)')
for line in p.open(errors='replace'):
 m=pattern.match(line)
 if not m:continue
 try:ts=datetime.fromisoformat(m[1].replace('Z','+00:00'))
 except ValueError:continue
 if ts<cut:continue
 g=groups.setdefault(m[2],{'durations':[],'ok':0,'failed':0});g['durations'].append(int(m[4]));g[m[3]]+=1
summary={}
for name,g in groups.items():
 d=sorted(g['durations']);summary[name]={'runs':len(d),'ok':g['ok'],'failed':g['failed'],'minMs':d[0],'medianMs':statistics.median(d),'p95Ms':d[max(0,int((len(d)*.95+.999999))-1)],'maxMs':d[-1]}
out={'utc':datetime.now(timezone.utc).isoformat(),'lookbackHours':24,'jobs':summary,'method':'Completed job log entries only; no breakdown of network, model, local CPU, cache or waiting, and no claim of independence or randomized workload.'};target=Path(__file__).resolve().parents[2]/'.local-evals/mcp-rust-benchmark/scheduler-jobs.json';target.write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
