"""Activate a verified local mail gate via the launcher's supported CLI override.

Never edits the signed application. Back up config/state first; restart only
the supervised scheduler and its current mail-promoter child. Explicit --apply.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import sqlite3
import subprocess
import time

ROOT=Path(__file__).resolve().parents[2]
SUPPORT=Path.home()/'Library/Application Support/Steward'
CONFIG=SUPPORT/'config.env'


def sha(path):
    result=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):result.update(block)
    return result.hexdigest()


def processes():
    result=[]
    for line in subprocess.check_output(['ps','-axo','pid=,ppid=,args='],text=True).splitlines():
        parts=line.strip().split(maxsplit=2)
        if len(parts)!=3:continue
        try:args=shlex.split(parts[2])
        except ValueError:continue
        if len(args)>1 and Path(args[0]).name=='node':result.append({'pid':int(parts[0]),'parent':int(parts[1]),'entry':args[1]})
    return result


def scheduler():
    found=[p for p in processes() if p['entry'].endswith('/services/scheduler/index.js')]
    if len(found)!=1:raise RuntimeError('Expected exactly one supervised scheduler')
    return found[0]


def patch_config(raw,patch):
    lines=[line for line in raw.splitlines() if not any(re.match(r'^\s*'+re.escape(key)+r'\s*=',line) for key in patch)]
    lines += [key+'='+json.dumps(value) for key,value in patch.items() if value is not None]
    return '\n'.join(lines)+'\n'


def atomic_config(text):
    temporary=CONFIG.with_suffix('.mail-gate.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as stream:stream.write(text);stream.flush();os.fsync(stream.fileno())
    temporary.chmod(0o600);temporary.replace(CONFIG)


def restart(old):
    # Do not overlap calendar/send-due/reconcile jobs across two schedulers.
    deadline=time.monotonic()+90
    while True:
        others=[p for p in processes() if p['parent']==old['pid'] and not (p['entry'].endswith('/cli/mail-promoter.js') or p['entry'].endswith('/mail-promoter.mjs'))]
        if not others:break
        if time.monotonic()>=deadline:raise RuntimeError('Other scheduler jobs still active; cutover deferred')
        time.sleep(.5)
    # Stop only the old distill child; other services and the launcher stay up.
    for p in processes():
        if p['parent']==old['pid'] and (p['entry'].endswith('/cli/mail-promoter.js') or p['entry'].endswith('/mail-promoter.mjs')):
            os.kill(p['pid'],signal.SIGTERM)
    os.kill(old['pid'],signal.SIGTERM)
    deadline=time.monotonic()+25
    while time.monotonic()<deadline:
        time.sleep(.5)
        try:new=scheduler()
        except RuntimeError:continue
        if new['pid']!=old['pid']:return new
    raise RuntimeError('Supervisor did not restart scheduler; config is backed up')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--release',type=Path,required=True);parser.add_argument('--apply',action='store_true');parser.add_argument('--rollback',action='store_true')
    args=parser.parse_args();release=args.release.resolve();manifest=release/'manifest.json';record=release/'activation.json'
    if args.rollback:
        saved=json.loads(record.read_text());old=scheduler();current=CONFIG.read_text()
        atomic_config(patch_config(current,saved['previousValues']));new=restart(old)
        saved['rolledBack']=True;saved['rollbackUtc']=dt.datetime.now(dt.timezone.utc).isoformat();record.write_text(json.dumps(saved,indent=2));print(json.dumps({'rolledBack':True,'schedulerPid':new['pid']}));return
    verification=json.loads((release/'worker-verification.json').read_text())
    assert verification['bankPositivesDiscarded']==0 and verification['maximumScoreDelta']<1e-8
    assert verification['overflowForwarded'] and verification['changedPolicyForwarded']
    assert verification['ready']['modelId']==sha(manifest)
    config=json.loads(manifest.read_text())
    for path,digest in config['files'].items():assert sha(Path(path))==digest
    assert (release/'mail-promoter.mjs').exists()
    old=scheduler()
    patch={'MAIL_PROMOTER_CLI':str(release/'mail-promoter.mjs'),'MAIL_PROMOTER_GTE_MODE':'enforce',
        'MAIL_PROMOTER_GTE_PYTHON':str(ROOT/'.local-models/mail-gate/venv/bin/python'),
        'MAIL_PROMOTER_GTE_MANIFEST':str(manifest),'MAIL_PROMOTER_GTE_WORKER':str(release/'gte_worker.py'),
        'MAIL_PROMOTER_MAX_GTE_SCORES':'500','MAIL_PROMOTER_MAX_GATEWAY_CALLS':'100','MAIL_PROMOTER_CONCURRENCY':'4'}
    if not args.apply:print(json.dumps({'ready':True,'modelId':sha(manifest),'schedulerPid':old['pid'],'patch':patch},indent=2));return
    if record.exists():raise RuntimeError('Activation record already exists; do not overwrite rollback history')
    previous=CONFIG.read_text();before={key:None for key in patch}
    for line in previous.splitlines():
        match=re.match(r'^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$',line)
        if match and match[1] in before:
            value=match[2];before[match[1]]=value[1:-1] if len(value)>1 and value[0]==value[-1] and value[0] in "\"'" else value
    backup=SUPPORT/'mail-gate-backups'/dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup.mkdir(parents=True,mode=0o700)
    (backup/'config.env').write_text(previous);(backup/'config.env').chmod(0o600)
    state_path=Path.home()/'Library/Application Support/mail-promoter/state.db'
    with sqlite3.connect(state_path.as_uri()+'?mode=ro',uri=True) as source,sqlite3.connect(backup/'state.db') as dest:source.backup(dest)
    (backup/'state.db').chmod(0o600)
    saved={'appliedUtc':dt.datetime.now(dt.timezone.utc).isoformat(),'previousValues':before,'patch':patch,
        'backup':str(backup),'modelId':sha(manifest),'cliSha256':sha(release/'mail-promoter.mjs'),'oldSchedulerPid':old['pid']}
    record.write_text(json.dumps(saved,indent=2));atomic_config(patch_config(previous,patch))
    try:
        new=restart(old)
        raw=subprocess.check_output(['ps','eww','-p',str(new['pid']),'-o','command='],text=True)
        for key,value in patch.items():
            match=re.search(r'(?:^|\s)'+key+r'=([^\s]+)',raw)
            assert match and match[1]==value,'Supervisor did not load '+key
        saved['newSchedulerPid']=new['pid'];saved['environmentVerified']=True;record.write_text(json.dumps(saved,indent=2))
        print(json.dumps({'active':True,'modelId':sha(manifest),'schedulerPid':new['pid'],'backup':str(backup)}))
    except BaseException:
        atomic_config(previous);saved['configurationRestoredAfterFailure']=True
        try:
            active=scheduler()
            if active['pid']!=old['pid']:restart(active)
        except Exception as error:saved['runtimeRestoreError']=type(error).__name__
        record.write_text(json.dumps(saved,indent=2));raise


if __name__=='__main__':main()
