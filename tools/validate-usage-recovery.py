"""Validate the separate SQLite recovery; never modifies the live Usage DB."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess

ROOT=Path(__file__).resolve().parents[1]
info=json.loads((ROOT/'.local-evals/usage-recovery/snapshot.json').read_text())
folder=Path(info['workDirectory']);dbpath=folder/'recovered.db'
os.environ['SQLITE_TMPDIR']=str(folder)
status=json.loads((folder/'recovery-status.json').read_text())
assert status['state']=='complete' and status['sourceExitCode']==status['targetExitCode']==0
result={'source':info,'recoveryStatus':status,'recoveredBytes':dbpath.stat().st_size,'tables':{},'backupComparison':{}}
check=subprocess.run(['/usr/bin/sqlite3',dbpath.as_uri()+'?immutable=1','PRAGMA integrity_check;'],capture_output=True,text=True,env=dict(os.environ))
result['integrityCheck']={'exitCode':check.returncode,'output':check.stdout.strip(),'stderr':check.stderr.strip()}
(folder/'integrity-check.json').write_text(json.dumps(result['integrityCheck'],indent=2))
assert check.returncode==0 and check.stdout.strip()=='ok'
db=sqlite3.connect(dbpath.as_uri()+'?mode=ro&immutable=1',uri=True)
db.row_factory=sqlite3.Row
names=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
for name in names:
    assert name.replace('_','').isalnum()
    columns=[r[1] for r in db.execute('PRAGMA table_info("'+name+'")')]
    summary={'rows':db.execute('SELECT count(*) FROM "'+name+'"').fetchone()[0]}
    if {'id','ts'}.issubset(columns):
        summary.update(dict(db.execute('SELECT min(id) minId,max(id) maxId,min(ts) firstTs,max(ts) lastTs FROM "'+name+'"').fetchone()))
    result['tables'][name]=summary
paid=dict(db.execute('''SELECT count(*) calls,round(sum(cost_usd),9) recordedCostUsd,
    sum(input_tokens) input,sum(output_tokens) output,sum(cache_read_tokens) cacheRead,
    sum(cache_write_tokens) cacheWrite,min(ts) firstTs,max(ts) lastTs
    FROM llm_calls WHERE cost_usd>0''').fetchone())
result['positiveCostCalls']=paid
result['paidByDay']=[dict(r) for r in db.execute("SELECT date(ts/1000,'unixepoch') day,count(*) calls,round(sum(cost_usd),9) recordedCostUsd FROM llm_calls WHERE cost_usd>0 GROUP BY 1 ORDER BY 1")]
result['recordedCallsByDay']=[dict(r) for r in db.execute("SELECT date(ts/1000,'unixepoch') day,count(*) calls,sum(ok) ok,sum(cost_usd>0) positiveCostCalls FROM llm_calls GROUP BY 1 ORDER BY 1")]
result['invalidCallRows']=db.execute('''SELECT count(*) FROM llm_calls WHERE
    typeof(ts)!='integer' OR ts<0 OR typeof(input_tokens)!='integer' OR input_tokens<0
    OR typeof(output_tokens)!='integer' OR output_tokens<0
    OR typeof(cache_read_tokens)!='integer' OR cache_read_tokens<0
    OR typeof(cache_write_tokens)!='integer' OR cache_write_tokens<0
    OR typeof(cost_usd) NOT IN ('integer','real') OR cost_usd<0
    OR typeof(duration_ms)!='integer' OR duration_ms<0 OR ok NOT IN (0,1)''').fetchone()[0]
backup=Path.home()/'Library/Application Support/Steward/deploy/backups/2026-10-21T14-36-20-432Z-5bb2a2e5/usage.db'
db.execute('ATTACH DATABASE ? AS known',(backup.as_uri()+'?mode=ro&immutable=1',))
for name in ['turns','llm_calls','provider_attempts','tool_calls','voice_calls']:
    columns=[r[1] for r in db.execute('PRAGMA known.table_info('+name+')')]
    differences=' OR '.join('a."'+c+'" IS NOT b."'+c+'"' for c in columns)
    row=db.execute('SELECT count(*) baselineRows,sum(b.id IS NULL) missingRows,'
        'sum(b.id IS NOT NULL AND ('+differences+')) differingRows FROM known.'+name+' a LEFT JOIN main.'+name+' b ON b.id=a.id').fetchone()
    result['backupComparison'][name]=dict(row)
db.close()
h=hashlib.sha256()
with dbpath.open('rb') as stream:
    for block in iter(lambda:stream.read(8*1024*1024),b''):h.update(block)
result.update(sha256=h.hexdigest(),validatedUtc=dt.datetime.now(dt.timezone.utc).isoformat(),liveDatabaseModified=False)
(folder/'validation.json').write_text(json.dumps(result,indent=2))
(ROOT/'.local-evals/usage-recovery/validation.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k not in {'paidByDay','recordedCallsByDay','source'}},indent=2))
