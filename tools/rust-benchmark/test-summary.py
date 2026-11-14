#!/usr/bin/env python3
import os,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];env={**os.environ,'STEWARD_SQLITE_RUNTIME_TEST':'1','TZ':'Europe/Rome'}
with tempfile.TemporaryDirectory(prefix='steward-usage-summary-') as tmp:
 for variant in ['empty','filled']:
  path=Path(tmp)/(variant+'.db')
  subprocess.run(['node','--import',str(root/'tools/sqlite-runtime-preload.mjs'),str(root/'tools/rust-benchmark/create-fixture.mjs'),str(path),variant],env=env,cwd=root,check=True)
  for days in ['all','30','7']:
   result=subprocess.run(['python3',str(root/'tools/rust-benchmark/compare-summary.py'),str(path),'1794500000000',days],env=env,cwd=root,text=True,capture_output=True)
   if result.returncode:raise RuntimeError(f'{variant}/{days}: {result.stderr[-1500:]}')
print('PASS: complete ordered summaries; empty/populated, nulls, Unicode, stream booleans, three windows and Europe/Rome DST')
