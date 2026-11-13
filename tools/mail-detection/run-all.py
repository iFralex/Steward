"""Resume the local experiment; sound on completion, failure or interruption."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[2]


def sound():
    if sys.platform == 'darwin':
        subprocess.run(['/usr/bin/afplay', '/System/Library/Sounds/Glass.aiff'], check=False)


def interrupted(signum, frame):
    raise KeyboardInterrupt


def main(args):
    free = shutil.disk_usage(ROOT).free / 1024**3
    if free < args.min_free_gib:
        raise RuntimeError(f'{free:.2f} GiB free; at least {args.min_free_gib:g} GiB required before resuming.')
    interpreter = ROOT / '.local-evals/mail-detection/venv/bin/python'
    if not interpreter.exists():
        raise RuntimeError('Create the isolated environment described in tools/mail-detection/README.md first.')
    started = time.perf_counter()
    commands = []
    baselines = [] if args.start_at == 'gte-setfit' else ['bge'] if args.start_at == 'bge' else ['gte', 'bge']
    for model in baselines:
        commands.extend([['run.py', 'embed', '--name', model], ['run.py', 'fit', '--name', model],
                         ['run.py', 'profile', '--name', model]])
    if not args.baseline_only:
        commands.extend([
            ['finetune.py', '--train-last-layers', str(args.train_last_layers)],
            ['run.py', 'embed', '--name', 'gte-setfit', '--fine-tuned', '.local-evals/mail-detection/setfit-model'],
            ['run.py', 'fit', '--name', 'gte-setfit'],
            ['run.py', 'profile', '--name', 'gte-setfit', '--fine-tuned', '.local-evals/mail-detection/setfit-model'],
        ])
    for command in commands:
        process = subprocess.Popen([str(interpreter), '-u', str(ROOT / 'tools/mail-detection' / command[0]), *command[1:]],
                                   cwd=ROOT, start_new_session=True)
        try:
            code = process.wait()
            if code:
                raise subprocess.CalledProcessError(code, command)
        except BaseException:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            raise
    directory = ROOT / '.local-evals/mail-detection'
    reports = {name: json.loads((directory / name / 'report.json').read_text())
               for name in ['gte', 'bge', 'gte-setfit'] if (directory / name / 'report.json').exists()}
    profiles = {name: json.loads((directory / name / 'profile.json').read_text())
                for name in reports if (directory / name / 'profile.json').exists()}
    result = {'seconds': time.perf_counter()-started, 'productionEnabled': False, 'models': reports, 'profiles': profiles}
    (directory / 'comparison.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline-only', action='store_true')
    parser.add_argument('--start-at', choices=['gte', 'bge', 'gte-setfit'], default='gte')
    parser.add_argument('--min-free-gib', type=float, default=10.)
    parser.add_argument('--train-last-layers', type=int, default=0)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main(args)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Experiment stopped: {error}', file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print('Experiment interrupted; flushed embeddings can be resumed.', file=sys.stderr)
        sys.exit(130)
    finally:
        try:
            if (ROOT / '.local-evals/mail-detection/dataset.jsonl').exists():
                from report import collect
                collect(ROOT / '.local-evals/mail-detection')
        except Exception as error:
            print(f'Could not collect completed stages: {error}', file=sys.stderr)
        finally:
            sound()
