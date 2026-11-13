"""Persistent sequential runner; its process group can be stopped via runner.pid."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local-evals/mail-detection-decisions'


def write_status(stage, **extra):
    value = {'stage': stage, 'pid': os.getpid(), 'updatedUnix': time.time(),
             'paidCalls': 0, 'productionEnabled': False, **extra}
    path = OUT / 'runner-status.json'; tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2)); tmp.replace(path)
    print(json.dumps(value), flush=True)


def passed(path):
    return path.exists() and json.loads(path.read_text()).get('passed') is True


def command(name, *args):
    subprocess.run([sys.executable, str(ROOT / 'tools/mail-detection' / name), *args],
                   cwd=ROOT, check=True)


def main():
    OUT.mkdir(exist_ok=True, mode=0o700)
    with (OUT / 'runner.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('An existing persistent runner holds the lock', flush=True)
            return
        (OUT / 'runner.pid').write_text(str(os.getpid()) + '\n')
        os.environ['LAYA_BENCHMARK_DEVICE'] = 'cpu'
        os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
        sys.dont_write_bytecode = True
        try:
            laya = ROOT / '.local-evals/mail-detection-laya'
            if not passed(laya / 'verification.json'):
                write_status('finishing-laya-cpu')
                command('laya-benchmark.py', 'finish')
            assert passed(laya / 'verification.json')
            qwen = ROOT / '.local-evals/mail-detection-openjev'
            if not passed(qwen / 'verification.json') or not (qwen / 'evaluation.json').exists():
                write_status('continuing-openjev')
                command('continue-decision-models.py')
            assert passed(qwen / 'verification.json')
            write_status('generating-combined-report')
            command('report-decision-models.py')
            write_status('restoring-original-gte-cache')
            command('restore-gte-cache.py')
            write_status('complete', report=str(OUT / 'comparison.md'))
        except BaseException as error:
            write_status('error', error=str(error))
            raise
        finally:
            subprocess.run(['afplay', '/System/Library/Sounds/Glass.aiff'], check=False)


if __name__ == '__main__':
    main()
