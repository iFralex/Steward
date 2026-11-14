#!/usr/bin/env python3
import json,time
from pathlib import Path
from datetime import datetime,timezone
src=Path(__file__).with_name('mcp-probe.py').read_text().split("with tempfile.TemporaryDirectory(prefix='steward-mcp-benchmark-') as temp:")[0];ns={'__file__':__file__};exec(compile(src,'mcp-probe-support','exec'),ns);Client=ns['Client'];c=Client('trains');out={'utc':datetime.now(timezone.utc).isoformat(),'tests':[]}
try:
 for origin,destination in [('Milano Centrale','Monza'),('Roma Termini','Roma Tiburtina')]:
  start=time.monotonic()
  try:
   r=c.call('tools/call',{'name':'find_next_train','arguments':{'from':origin,'to':destination}},timeout=40);elapsed=time.monotonic()-start;payload=json.loads(r['content'][0]['text']);ref=payload.get('trainRef') if isinstance(payload,dict) else None
   out['tests'].append({'tool':'find_next_train','route':origin+' → '+destination,'seconds':elapsed,'success':not r.get('isError',False),'trainRefPresent':bool(ref)})
   if ref:
    t=time.monotonic();z=c.call('tools/call',{'name':'train_status','arguments':{'trainRef':ref}},timeout=40);out['tests'].append({'tool':'train_status','seconds':time.monotonic()-t,'success':not z.get('isError',False)});break
  except Exception as e:out['tests'].append({'tool':'find_next_train','route':origin+' → '+destination,'seconds':time.monotonic()-start,'errorType':type(e).__name__})
finally:c.close()
(ns['root']/'.local-evals/mcp-rust-benchmark/trains.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
