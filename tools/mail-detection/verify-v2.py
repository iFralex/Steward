"""Actual local preview routing and cache/scaler checks, with no mail actions."""
import json
from pathlib import Path
import subprocess
import sys

import joblib
import numpy as np

from metadata import metadata_features
from run import ROOT, atomic_json, load_dataset


def check_preview(directory, name):
    rows, digest = load_dataset(directory)
    artifact = joblib.load(directory / name / 'classifier-conservative.joblib')
    assert artifact['datasetSha256'] == digest
    base_name = name.removesuffix('-meta')
    embeddings = np.load(directory / base_name / 'features.npy')
    lengths = np.load(directory / base_name / 'token-lengths.npy')
    valid = lengths <= 8192
    assert np.isfinite(embeddings[valid]).all()
    assert np.allclose(np.linalg.norm(embeddings[valid], axis=1), 1., atol=.01)
    features = embeddings
    if 'metadata' in artifact:
        recipe = artifact['metadata']
        raw = np.stack([metadata_features(row['text']) for row in rows])
        train = np.asarray([row['split'] == 'train' for row in rows]) & valid
        assert int(recipe['scaler'].n_samples_seen_) == int(train.sum())
        assert np.allclose(recipe['scaler'].mean_, raw[train].mean(axis=0, dtype=np.float64), atol=1e-10)
        features = np.concatenate([features, recipe['scaler'].transform(raw) * recipe['weight']], axis=1)
    assert features.shape[1] == artifact['classifier'].n_features_in_
    scores = artifact['classifier'].predict_proba(features)[:, 1]
    # Use clear, short test examples for runtime checks, after every model
    # choice has been fixed. This never tunes the threshold on test labels.
    positives = [i for i, row in enumerate(rows) if row['split'] == 'test' and row['label'] == 1
                 and lengths[i] <= 1536 and scores[i] >= artifact['threshold']]
    negatives = [i for i, row in enumerate(rows) if row['split'] == 'test' and row['label'] == 0
                 and lengths[i] <= 1536 and scores[i] < artifact['threshold']]
    indices = [max(positives, key=lambda i: scores[i]), min(negatives, key=lambda i: scores[i]), int(np.flatnonzero(~valid)[0])]
    payload = ''.join(json.dumps({'text': rows[i]['text']}, ensure_ascii=True) + '\n' for i in indices)
    command = [sys.executable, str(ROOT / 'tools/mail-detection/predict.py'), '--directory', str(directory), '--name', name]
    completed = subprocess.run(command, input=payload, text=True, capture_output=True, check=True)
    results = [json.loads(line) for line in completed.stdout.splitlines()]
    assert [result['route'] for result in results] == ['llm', 'discard_candidate', 'llm'], results
    assert all(result['previewOnly'] for result in results)
    assert results[2]['reason'] == 'context_overflow'
    delta = max(abs(results[j]['score'] - float(scores[i])) for j, i in enumerate(indices[:2]))
    assert delta < .01, delta
    return {'model': name, 'validCachedEmbeddings': int(valid.sum()), 'overflowExamples': int((~valid).sum()),
            'cacheAndPreviewRoutesAgree': True, 'maximumCachedScoreDelta': delta,
            'metadataScalerTrainingOnlyVerified': 'metadata' in artifact, 'preview': results}


if __name__ == '__main__':
    directory = ROOT / '.local-evals/mail-detection-v2'
    selection = json.loads((directory / 'selection.json').read_text())
    assert selection['testUsedForSelection'] is False
    results = []
    for name in selection['validation']:
        result = check_preview(directory, name)
        results.append(result)
        print(json.dumps({'event': 'preview_verified', 'model': name,
                          'maximumCachedScoreDelta': result['maximumCachedScoreDelta']}), flush=True)
    migrated = check_preview(ROOT / '.local-evals/mail-detection', 'gte-setfit')
    atomic_json(directory / 'inference-verification.json', {'models': results, 'migratedV1Checkpoint': migrated,
                                                          'paidLlmCalls': 0, 'mailActions': 0})
    print('All model previews, overflow routes and migrated V1 checkpoint verified.', flush=True)
