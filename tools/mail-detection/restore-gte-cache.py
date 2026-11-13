"""Restore the temporarily rotated public GTE blob, checking its original SHA."""
import hashlib
import fcntl
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local-evals/mail-detection-decisions'


def restore():
    manifest = OUT / 'gte-cache-rotation.json'
    if not manifest.exists(): return
    info = json.loads(manifest.read_text()); target = Path(info['blobPath'])
    assert target.parent == ROOT / '.local-models/hub/models--Alibaba-NLP--gte-multilingual-base/blobs'
    removed = None
    if not target.exists():
        temporary = target.with_suffix('.restore-partial')
        if temporary.exists(): temporary.unlink()
        reserve = 128*1024**2
        if shutil.disk_usage(ROOT).free < info['bytes'] + reserve:
            qwen = ROOT / '.local-evals/mail-detection-openjev'
            assert json.loads((qwen / 'verification.json').read_text())['passed']
            assert (OUT / 'comparison.json').exists()
            weight = ROOT / '.local-models/qwen35-08b-mlx4/model.safetensors'
            provenance = json.loads((weight.parent / 'download-provenance.json').read_text())
            if weight.exists():
                assert hashlib.file_digest(weight.open('rb'), 'sha256').hexdigest() == provenance['weightsSha256']
                removed = {'path': str(weight), 'bytes': weight.stat().st_size, 'provenance': provenance}
                weight.unlink()
        if shutil.disk_usage(ROOT).free < info['bytes'] + reserve:
            raise RuntimeError('Insufficient space to restore GTE; rotation manifest preserved')
        with urllib.request.urlopen(info['restoreUrl']) as source, temporary.open('wb') as output:
            shutil.copyfileobj(source, output, 1024*1024)
        assert temporary.stat().st_size == info['bytes']
        assert hashlib.file_digest(temporary.open('rb'), 'sha256').hexdigest() == info['sha256']
        temporary.replace(target)
    assert hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() == info['sha256']
    assert Path(info['snapshotPath']).is_file()
    (OUT / 'gte-cache-restored.json').write_text(json.dumps({'restored': True,
        'sha256': info['sha256'], 'snapshotPath': info['snapshotPath'], 'bytes': info['bytes'],
        'publicQwenWeightsRotatedIfNecessary': removed, 'currentTrainedCheckpointsPreserved': True}, indent=2))
    print('Original GTE public cache restored and verified', flush=True)


def main():
    OUT.mkdir(exist_ok=True, mode=0o700)
    with (OUT / 'gte-restore.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        restore()


if __name__ == '__main__': main()
