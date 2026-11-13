"""Run Qwen only after Laya finishes, rotating its reproducible public weights."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LAYA = ROOT / '.local-evals/mail-detection-laya'
OUT = ROOT / '.local-evals/mail-detection-openjev'
VENV = ROOT / '.local-evals/mail-detection-mlx-venv'
MODEL = ROOT / '.local-models/qwen35-08b-mlx4'


def status(stage, **extra):
    OUT.mkdir(exist_ok=True, mode=0o700)
    path = OUT / 'continuation-status.json'; tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps({'stage': stage, **extra}, indent=2)); tmp.replace(path)
    print(stage, flush=True)


def run():
    status('waiting-for-laya-verification')
    while not (LAYA / 'verification.json').exists():
        path = LAYA / 'status.json'
        if path.exists() and json.loads(path.read_text()).get('state') == 'error':
            raise RuntimeError('Laya stopped: retain its weights and inspect the error')
        time.sleep(5)
    assert json.loads((LAYA / 'verification.json').read_text())['passed']
    time.sleep(5)
    # This is a downloaded, unchanged public checkpoint, not a trained artifact.
    # All private trained weights and evaluated outputs are preserved.
    weight = ROOT / '.local-models/laya-multilingual/model.safetensors'
    provenance = json.loads((weight.parent / 'download-provenance.json').read_text())
    if weight.exists():
        assert weight.stat().st_size == 643835514
        assert hashlib.file_digest(weight.open('rb'), 'sha256').hexdigest() == provenance['weightsSha256']
        weight.unlink()
        (LAYA / 'public-weight-cache-rotation.json').write_text(json.dumps({
            'removedOnly': str(weight), 'provenance': provenance,
            'reason': 'Laya verified; reuse limited disk for Qwen; public weights can be downloaded again',
            'privateTrainedWeightsPreserved': True}, indent=2))
    status('installing-isolated-mlx', freeBytes=shutil.disk_usage(ROOT).free)
    if not VENV.exists():
        subprocess.run([sys.executable, '-m', 'venv', '--system-site-packages', str(VENV)], check=True)
    with (OUT / 'install.log').open('a') as log:
        subprocess.run([str(VENV / 'bin/pip'), 'install', '--no-cache-dir', '--no-compile',
            'mlx-lm==0.31.3', 'mlx==0.32.4', 'transformers==5.22.2'],
            stdout=log, stderr=subprocess.STDOUT, check=True)
    with (OUT / 'environment-freeze.txt').open('w') as output:
        subprocess.run([str(VENV / 'bin/pip'), 'freeze'], stdout=output, check=True)
    status('downloading-pinned-qwen')
    info = json.loads((ROOT / '.local-evals/mail-detection-followup/research/openjev/qwen-model-info.json').read_text())
    MODEL.mkdir(exist_ok=True)
    names = {'config.json', 'model.safetensors', 'model.safetensors.index.json',
             'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja', 'vocab.json'}
    for item in info['siblings']:
        name = item['rfilename']
        if name not in names: continue
        path = MODEL / name
        if not path.exists():
            if shutil.disk_usage(ROOT).free < item['size'] + 128 * 1024**2:
                raise RuntimeError('Not enough disk for pinned Qwen plus 128 MiB reserve')
            temporary = path.with_suffix(path.suffix + '.partial')
            url = 'https://huggingface.co/' + info['id'] + '/resolve/' + info['sha'] + '/' + name
            with urllib.request.urlopen(url) as source, temporary.open('wb') as output:
                shutil.copyfileobj(source, output, 1024*1024)
            temporary.replace(path)
        assert path.stat().st_size == item['size']
        if item.get('lfs', {}).get('sha256'):
            assert hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() == item['lfs']['sha256']
    (MODEL / 'download-provenance.json').write_text(json.dumps({'repo': info['id'],
        'revision': info['sha'], 'weightsSha256': hashlib.file_digest((MODEL / 'model.safetensors').open('rb'), 'sha256').hexdigest()}, indent=2))
    status('benchmarking-openjev', freeBytes=shutil.disk_usage(ROOT).free)
    with (OUT / 'run.log').open('a') as log:
        subprocess.run([sys.executable, str(ROOT / 'tools/mail-detection/openjev-benchmark.py'), 'run'],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    status('complete', paidCalls=0, productionEnabled=False)


if __name__ == '__main__':
    try:
        run()
    except BaseException as error:
        status('error', error=str(error)); raise
    finally:
        subprocess.run(['afplay', '/System/Library/Sounds/Glass.aiff'], check=False)
