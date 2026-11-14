#!/usr/bin/env python3
import json
from pathlib import Path
from datetime import datetime,timezone
src=Path(__file__).with_name('mcp-probe.py').read_text().split("with tempfile.TemporaryDirectory(prefix='steward-mcp-benchmark-') as temp:")[0];ns={'__file__':__file__};exec(compile(src,'mcp-probe-support','exec'),ns);c=ns['Client']('mail');out={'utc':datetime.now(timezone.utc).isoformat(),'tests':[]}
try:
 for name,args in [('list_mailboxes',{}),('list_write_operations',{'limit':1})]:
  try:out['tests'].append(ns['trial'](c,name,args,3))
  except Exception as e:out['tests'].append({'tool':name,'errorType':type(e).__name__})
 raw=c.call('tools/call',{'name':'list_write_operations','arguments':{'limit':1}});data=json.loads(raw['content'][0]['text']);items=data if isinstance(data,list) else data.get('operations',data.get('items',[])) if isinstance(data,dict) else []
 out['writeJournalShape']={'type':type(data).__name__,'keys':list(data) if isinstance(data,dict) else [],'length':len(items) if isinstance(items,list) else 0}
 if isinstance(items,list) and items:
  row=items[0];op=row.get('operationId',row.get('operation_id',row.get('id')))
  if isinstance(op,str):
   try:out['tests'].append(ns['trial'](c,'read_write_operation',{'operationId':op},3))
   except Exception as e:out['tests'].append({'tool':'read_write_operation','errorType':type(e).__name__})
finally:c.close()
(ns['root']/'.local-evals/mcp-rust-benchmark/mail-extra.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
