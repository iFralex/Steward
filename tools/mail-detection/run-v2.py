"""Run the fixed second experiment; decide metadata work on validation only."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

from run import ROOT, atomic_json

DIRECTORY = ROOT / '.local-evals/mail-detection-v2'
PYTHON = ROOT / '.local-evals/mail-detection/venv/bin/python'


def interrupted(signum, frame):
    raise KeyboardInterrupt


def main(args):
    logs = DIRECTORY / 'logs'
    logs.mkdir(exist_ok=True)
    commands = [('gte-embed', ['run.py', 'embed', '--name', 'gte']),
                ('gte-fit', ['run.py', 'fit', '--name', 'gte']),
                ('bge-embed', ['run.py', 'embed', '--name', 'bge']),
                ('bge-fit', ['run.py', 'fit', '--name', 'bge']),
                ('setfit-train', ['finetune.py', '--steps', '600', '--examples', '1024', '--train-last-layers', '2', '--hard-pairs', '--adapter-only', '--device', args.training_device]),
                ('setfit-embed', ['run.py', 'embed', '--name', 'gte-setfit', '--fine-tuned', str(DIRECTORY / 'setfit-model')]),
                ('setfit-fit', ['run.py', 'fit', '--name', 'gte-setfit'])]
    commands = commands[[stage for stage, _ in commands].index(args.start_at):]
    for stage, command in commands:
        atomic_json(DIRECTORY / 'status.json', {'stage': stage, 'state': 'running', 'productionEnabled': False})
        print(json.dumps({'stage': stage, 'state': 'starting'}), flush=True)
        with (logs / f'{stage}.log').open('w') as log:
            process = subprocess.Popen([str(PYTHON), '-u', str(ROOT / 'tools/mail-detection' / command[0]),
                                        *command[1:], '--directory', str(DIRECTORY)],
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True, cwd=ROOT)
            try:
                if process.wait():
                    raise RuntimeError(f'{stage} failed; inspect {logs / (stage + ".log")}')
            except BaseException:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                raise
        print(json.dumps({'stage': stage, 'state': 'complete'}), flush=True)
    # The criterion was fixed before examining the new test metrics. Read only
    # validation fields to decide whether the conditional metadata study runs.
    validation = {name: json.loads((DIRECTORY / name / 'report.json').read_text())['conservativeValidationPolicy']['validation']
                  for name in ['gte', 'bge', 'gte-setfit']}
    baseline = max(validation[name]['llmCallsAvoidedFraction'] for name in ['gte', 'bge'])
    tuned = validation['gte-setfit']
    sufficient = tuned['falseNegative'] == 0 and tuned['llmCallsAvoidedFraction'] >= baseline + .03
    decision = {'criterion': 'At least +3 percentage points validation discard rate versus the best frozen encoder, with zero validation positive misses.',
                'validation': validation, 'metadataRequired': not sufficient,
                'testUsedForThisDecision': False}
    atomic_json(DIRECTORY / 'metadata-decision.json', decision)
    atomic_json(DIRECTORY / 'status.json', {'stage': 'metadata_pending' if not sufficient else 'final_verification',
                                          'state': 'baselines_and_setfit_complete', 'productionEnabled': False})
    print(json.dumps(decision, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--start-at', choices=['gte-embed', 'bge-embed', 'setfit-train', 'setfit-embed'], default='gte-embed')
    parser.add_argument('--training-device', choices=['auto', 'mps', 'cpu'], default='auto')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main(args)
    except BaseException:
        atomic_json(DIRECTORY / 'status.json', {'state': 'interrupted_or_failed', 'productionEnabled': False})
        if sys.platform == 'darwin':
            subprocess.run(['/usr/bin/afplay', '/System/Library/Sounds/Glass.aiff'], check=False)
        raise
