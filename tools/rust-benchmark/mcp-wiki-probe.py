#!/usr/bin/env python3
import json,time
from pathlib import Path
from datetime import datetime,timezone
src=Path(__file__).with_name('mcp-probe.py').read_text().split("with tempfile.TemporaryDirectory(prefix='steward-mcp-benchmark-') as temp:")[0];ns={'__file__':__file__};exec(compile(src,'mcp-probe-support','exec'),ns);Client=ns['Client'];trial=ns['trial'];c=Client('llm-wiki');rows=[]
try:
 for tool,args in [('llm_wiki_files',{'project_id':'current','root':'wiki','recursive':False,'max_files':2000}),('llm_wiki_read_file',{'project_id':'current','path':'wiki/index.md','content_limit':500}),('llm_wiki_graph',{'project_id':'current','q':'stewardbenchmarkabsent9e7318fd','limit':3})]:
  try:rows.append(trial(c,tool,args,3))
  except Exception as e:rows.append({'tool':tool,'errorType':type(e).__name__})
finally:c.close()
out={'utc':datetime.now(timezone.utc).isoformat(),'tests':rows,'notes':'Read-only calls against the installed wiki API. Tool results are discarded; the index path may be absent.'};(ns['root']/'.local-evals/mcp-rust-benchmark/mcp-wiki.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
