#!/usr/bin/env python3
"""Combine aggregate-only MCP observations; no returned tool payloads."""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[2];d=root/'.local-evals/mcp-rust-benchmark';base=json.loads((d/'mcp-results.json').read_text());extra=json.loads((d/'mcp-extended.json').read_text());wiki=json.loads((d/'mcp-wiki.json').read_text());mail=json.loads((d/'mail-extra.json').read_text());trains=json.loads((d/'trains.json').read_text());out={}
for name,meta in base['results'].items():
 success={t['tool'] for t in meta.get('tests',[]) if t.get('toolErrors')==0};success|={t['tool'] for t in extra['results'].get(name,{}).get('tests',[]) if t.get('toolErrors')==0}
 if name=='llm-wiki':success|={t['tool'] for t in wiki['tests'] if t.get('toolErrors')==0}
 if name=='mail':success|={t['tool'] for t in mail['tests'] if t.get('toolErrors')==0}
 if name=='trains':success|={t['tool'] for t in trains['tests'] if t.get('success')}
 listed=set(meta.get('toolNames',[]));out[name]={'listed':len(listed),'successfullyMeasured':sorted(success),'notMeasured':sorted(listed-success)}
report={'servers':out,'totalListed':sum(x['listed'] for x in out.values()),'totalSuccessfullyMeasured':sum(len(x['successfullyMeasured']) for x in out.values()),'voice':'Voice MCP is not counted; only host /voice/status was probed.'};(d/'coverage.json').write_text(json.dumps(report,indent=2));print(json.dumps({'totalListed':report['totalListed'],'totalSuccessfullyMeasured':report['totalSuccessfullyMeasured']},indent=2))
