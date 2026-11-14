#!/usr/bin/env python3
import json,struct,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='steward-rust-test-') as tmp:
 p=Path(tmp);binary=p/'groups';subprocess.run(['rustc','-O','--edition','2021',str(root/'tools/rust-benchmark/groups.rs'),'-o',str(binary)],check=True)
 data=p/'fixture.bin';rows=[(10,2,3,0,.05,1,2,3,4,20261113,1794500000000.),(7,0,0,1,0.,1,3,3,4,20261112,1794400000000.),(4,2,1,0,.01,2,2,5,6,20261113,1794500010000.)];data.write_bytes(b''.join(struct.pack('<IIIIdIIIII4xd',*r) for r in rows))
 cutoff='1794450000000';js=subprocess.check_output(['node',str(root/'tools/rust-benchmark/groups.mjs'),str(data),cutoff],text=True);rs=subprocess.check_output([str(binary),str(data),cutoff],text=True);a,b=json.loads(js),json.loads(rs);assert a==b;assert a['count']==3 and len(a['groups'][4])==2
 invalid=p/'truncated.bin';invalid.write_bytes(data.read_bytes()[:-1]);assert subprocess.run([str(binary),str(invalid),cutoff],capture_output=True).returncode!=0;assert subprocess.run(['node',str(root/'tools/rust-benchmark/groups.mjs'),str(invalid),cutoff],capture_output=True).returncode!=0
 print('PASS: matching groups, cutoff, totals and malformed input')
