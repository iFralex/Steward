"""Local-only encoder comparison, conservative threshold selection and reports."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import shutil
import time
import urllib.request

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score

ROOT = Path(__file__).resolve().parents[2]
MODEL = 'Alibaba-NLP/gte-multilingual-base'
REVISION = '9bbca17d9273fd0d03d5725c7a4b0f6b45142062'
CODE_REVISION = '40ced75c3017eb27626c9d4ea981bde21a2662f4'
CACHE = ROOT / '.local-models/hub'
os.environ.setdefault('HF_MODULES_CACHE', str(ROOT / '.local-models/modules'))
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def local_request(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request('http://127.0.0.1:11434' + path, data=data,
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


class GTE:
    def __init__(self, fine_tuned=None):
        import torch
        from transformers import AutoModel, AutoTokenizer
        self.torch = torch
        self.device = 'mps' if torch.backends.mps.is_available() else 'cpu'
        self.peak_mps_bytes = 0
        torch.set_num_threads(4)
        base = str(CACHE / f'models--Alibaba-NLP--gte-multilingual-base/snapshots/{REVISION}')
        partial = Path(fine_tuned) / 'adapter_config.json' if fine_tuned else None
        partial = partial if partial and partial.exists() else None
        path = base if partial else fine_tuned or base
        self.tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True)
        self.model = AutoModel.from_pretrained(path, trust_remote_code=True, code_revision=CODE_REVISION,
                    cache_dir=str(CACHE), local_files_only=True, attn_implementation='sdpa',
                    torch_dtype=torch.float16 if self.device == 'mps' else torch.float32).to(self.device).eval()
        if partial:
            from safetensors.torch import load_file
            config = json.loads(partial.read_text())
            if config['baseRevision'] != REVISION or config['codeRevision'] != CODE_REVISION:
                raise RuntimeError('Partial fine-tune belongs to a different base encoder')
            updates = load_file(str(Path(fine_tuned) / 'adapter.safetensors'))
            expected = {name for name, _ in self.model.named_parameters()
                        if any(name.startswith(f'encoder.layer.{layer}.') for layer in config['updatedLayers'])}
            if set(updates) != expected:
                raise RuntimeError('Partial fine-tune has missing or unexpected parameter keys')
            self.model.load_state_dict(updates, strict=False)
        self.provenance = {'model': MODEL, 'revision': REVISION, 'codeRevision': CODE_REVISION,
                           'device': self.device, 'attention': 'sdpa', 'fineTuned': str(fine_tuned) if fine_tuned else None}
        if fine_tuned:
            with (Path(fine_tuned) / ('adapter.safetensors' if partial else 'model.safetensors')).open('rb') as stream:
                self.provenance['fineTunedWeightsSha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
            if partial:
                self.provenance['fineTunedFormat'] = 'partial-transformer-layers'

    def tokens(self, text):
        return len(self.tokenizer(text, truncation=False, add_special_tokens=True, verbose=False)['input_ids'])

    def encode(self, texts):
        torch = self.torch
        longest = max(self.tokens(text) for text in texts)
        bucket = min(8192, max(128, 2 ** math.ceil(math.log2(max(longest, 1)))))
        # Bound the number of compiled MPS graph shapes to seven length buckets.
        encoded = self.tokenizer(texts, padding='max_length', max_length=bucket,
                                 truncation=False, return_tensors='pt').to(self.device)
        with torch.inference_mode():
            output = self.model(**encoded).last_hidden_state[:, 0]
            result = torch.nn.functional.normalize(output.float(), dim=-1).cpu().numpy()
        if self.device == 'mps':
            torch.mps.synchronize()
            self.peak_mps_bytes = max(self.peak_mps_bytes, torch.mps.driver_allocated_memory())
            torch.mps.empty_cache()
        return result

    def memory(self):
        result = {'processPeakRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
        if self.device == 'mps':
            result['mpsDriverAllocatedBytes'] = self.torch.mps.driver_allocated_memory()
            result['mpsDriverObservedPeakBytes'] = self.peak_mps_bytes
        return result


class BGE:
    def __init__(self, fine_tuned=None):
        from tokenizers import Tokenizer
        path = CACHE / 'models--BAAI--bge-m3/snapshots/5617a9f61b028005a4858fdac845db406aefb181/tokenizer.json'
        self.tokenizer = Tokenizer.from_file(str(path))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        tags = local_request('/api/tags')['models']
        found = next(m for m in tags if m['name'] == 'bge-m3:latest')
        self.provenance = {'model': 'bge-m3:latest', 'digest': found['digest'], 'backend': 'existing local Ollama'}

    def tokens(self, text):
        return len(self.tokenizer.encode(text, add_special_tokens=True).ids)

    def encode(self, texts):
        response = local_request('/api/embed', {'model': 'bge-m3:latest', 'input': texts,
                'truncate': False, 'keep_alive': '10m', 'options': {'num_ctx': 8192, 'num_batch': 8192}})
        vectors = np.asarray(response['embeddings'], dtype=np.float32)
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if not np.isfinite(vectors).all() or np.any(norms < 1e-8):
            raise RuntimeError('Ollama returned invalid or zero embeddings')
        return vectors / norms

    def memory(self):
        # Embedding server is a different process. Do not report client RSS as model RAM.
        result = {'clientPeakRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
        for model in local_request('/api/ps').get('models', []):
            if model.get('digest') == self.provenance['digest']:
                result.update(ollamaResidentBytes=model.get('size'), ollamaVramBytes=model.get('size_vram'),
                              ollamaContextLength=model.get('context_length'))
        return result


def load_dataset(directory):
    path = directory / 'dataset.jsonl'
    return [json.loads(line) for line in path.open()], hashlib.sha256(path.read_bytes()).hexdigest()


def embed(args):
    rows, dataset_hash = load_dataset(args.directory)
    target = args.directory / args.name
    target.mkdir(exist_ok=True, mode=0o700)
    encoder = (BGE if args.name == 'bge' else GTE)(args.fine_tuned)
    print(json.dumps({'event': 'encoder_loaded', **encoder.provenance, **encoder.memory()}), flush=True)
    identity = {'datasetSha256': dataset_hash, 'encoder': encoder.provenance, 'maxTokens': 8192}
    manifest = target / 'manifest.json'
    if manifest.exists() and json.loads(manifest.read_text()) != identity:
        raise RuntimeError('Embedding cache belongs to a different dataset/model; choose a new --name.')
    manifest.write_text(json.dumps(identity, indent=2))
    metadata_path = target / 'embedding-metadata.json'
    try:
        metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    except json.JSONDecodeError:
        metadata = {}
    dimension = 1024 if args.name == 'bge' else 768
    cache = target / 'features.npy'
    vectors = np.lib.format.open_memmap(cache, mode='r+' if cache.exists() else 'w+', dtype=np.float32, shape=(len(rows), dimension))
    lengths_path = target / 'token-lengths.npy'
    if lengths_path.exists():
        lengths = np.load(lengths_path)
    else:
        lengths = np.asarray([encoder.tokens(row['text']) for row in rows])
        np.save(lengths_path, lengths)
    norms = np.linalg.norm(vectors, axis=1)
    for i in np.flatnonzero(np.isfinite(norms) & (norms > .99) & (norms < 1.01)):
        metadata.setdefault(str(i), {'tokens': int(lengths[i]), 'recovered': True})
    done = set(int(i) for i in metadata)
    pending = sorted([i for i in range(len(rows)) if i not in done and lengths[i] <= 8192], key=lambda i: lengths[i])
    if not pending and len(metadata) == len(rows) and (target / 'embedding-summary.json').exists():
        print(json.dumps({'event': 'embedding_cached', 'model': args.name, 'rows': len(rows)}), flush=True)
        return
    # Overflow always goes to the LLM. There is no silent input truncation.
    for i in range(len(rows)):
        if lengths[i] > 8192:
            metadata[str(i)] = {'overflow': True, 'tokens': int(lengths[i])}
    batch = []
    for position, i in enumerate(pending):
        batch.append(i)
        next_length = int(lengths[pending[position + 1]]) if position + 1 < len(pending) else 0
        if next_length and len(batch) < args.batch_size and next_length * (len(batch) + 1) <= args.token_budget:
            continue
        if shutil.disk_usage(ROOT).free < 1024**3:
            raise RuntimeError('Less than 1 GiB free; flushed embeddings are resumable after freeing disk space.')
        started = time.perf_counter()
        encoded = encoder.encode([rows[k]['text'] for k in batch])
        elapsed = time.perf_counter() - started
        for k, vector in zip(batch, encoded):
            if not np.isfinite(vector).all() or abs(float(np.linalg.norm(vector))-1) > .01:
                raise RuntimeError(f'Invalid or zero encoder output at row {k}')
            vectors[k] = vector
            metadata[str(k)] = {'tokens': int(lengths[k]), 'secondsPerItemInBatch': elapsed / len(batch), 'batchSize': len(batch)}
        vectors.flush()
        atomic_json(metadata_path, metadata)
        if position == len(pending) - 1 or (position + 1) // 100 != (position + 1 - len(batch)) // 100:
            print(json.dumps({'event': 'embedding_progress', 'model': args.name, 'done': len(metadata), 'total': len(rows),
                              'lastTokens': int(lengths[i]), **encoder.memory()}), flush=True)
        batch = []
    atomic_json(metadata_path, metadata)
    atomic_json(target / 'embedding-summary.json', {'rows': len(rows),
        'overflowExamples': int(np.sum(lengths > 8192)),
        'recoveredExamples': sum(bool(m.get('recovered')) for m in metadata.values()), **encoder.memory()})
    print(json.dumps({'event': 'embedding_complete', 'model': args.name, 'rows': len(rows),
                      'overflow': int(np.sum(lengths > 8192)), **encoder.memory()}), flush=True)


def wilson_lower(success, count):
    if not count:
        return None
    z = 1.96
    p = success / count
    return (p + z*z/(2*count) - z * math.sqrt(p*(1-p)/count + z*z/(4*count*count))) / (1+z*z/count)


def metrics(labels, scores, threshold):
    keep = scores >= threshold
    pos = labels == 1
    tp, fn = int(np.sum(keep & pos)), int(np.sum(~keep & pos))
    fp, tn = int(np.sum(keep & ~pos)), int(np.sum(~keep & ~pos))
    return {'examples': len(labels), 'positiveExamples': int(np.sum(pos)),
            'truePositive': tp, 'falseNegative': fn, 'falsePositive': fp, 'trueNegative': tn,
            'recallKeep': tp / max(tp + fn, 1), 'recallKeepWilson95Lower': wilson_lower(tp, tp+fn),
            'precisionKeep': tp / max(tp+fp, 1), 'llmCallsAvoidedFraction': (tn+fn)/len(labels),
            'discardPrecision': tn / max(tn+fn, 1), 'correctlyAvoidedLlmFraction': tn/len(labels),
            'rocAuc': float(roc_auc_score(labels, scores)), 'averagePrecision': float(average_precision_score(labels, scores))}


def fit(args):
    rows, dataset_hash = load_dataset(args.directory)
    summary_path = args.directory / 'dataset-summary.json'
    dataset_policy = json.loads(summary_path.read_text()) if summary_path.exists() else {}
    target = args.directory / args.name
    identity = json.loads((target / 'manifest.json').read_text())
    if identity['datasetSha256'] != dataset_hash:
        raise RuntimeError('Dataset hash mismatch')
    metadata = json.loads((target / 'embedding-metadata.json').read_text())
    if len(metadata) != len(rows):
        raise RuntimeError('Embedding run is incomplete')
    features = np.load(target / 'features.npy')
    labels = np.asarray([r['label'] for r in rows])
    splits = np.asarray([r['split'] for r in rows])
    overflow = np.asarray([metadata[str(i)].get('overflow', False) for i in range(len(rows))])
    features[overflow] = 0.
    train = (splits == 'train') & ~overflow
    validation = splits == 'validation'
    test = splits == 'test'
    candidates = []
    conservative_candidates = []
    for c in [.1, 1, 10, 100]:
        classifier = LogisticRegression(C=c, max_iter=2000, random_state=20261103).fit(features[train], labels[train])
        scores = classifier.predict_proba(features)[:, 1]
        scores[overflow] = 1.
        positives = np.sort(scores[validation & (labels == 1)])
        allowed_errors = math.floor(len(positives) * (1 - args.target_recall) + 1e-9)
        threshold = float(positives[min(allowed_errors, len(positives)-1)])
        validation_metrics = metrics(labels[validation], scores[validation], threshold)
        candidates.append((validation_metrics['llmCallsAvoidedFraction'], -c, classifier, threshold, scores, validation_metrics))
        strict_threshold = float(positives[0])
        strict_validation = metrics(labels[validation], scores[validation], strict_threshold)
        conservative_candidates.append((strict_validation['llmCallsAvoidedFraction'], -c,
                                        classifier, strict_threshold, scores, strict_validation))
    _, _, classifier, threshold, scores, validation_metrics = max(candidates, key=lambda x: x[:2])
    report = {'datasetSha256': dataset_hash, 'encoder': identity['encoder'], 'targetValidationRecall': args.target_recall,
              'threshold': threshold, 'classifierC': classifier.C, 'trainExamples': int(np.sum(train)),
              'validation': validation_metrics, 'test': metrics(labels[test], scores[test], threshold),
              'overflowExamplesForwardedToLlm': int(np.sum(overflow)),
              'latency': {'medianSecondsPerItemInBatch': float(np.median([m['secondsPerItemInBatch'] for m in metadata.values() if 'secondsPerItemInBatch' in m])),
                          'note': 'Throughput measurement; includes tokenization and batching. Not single-request p50.'},
              'limitations': ['Historical labels are LLM decisions, not human ground truth.',
                             'A promoted state can preserve an earlier promotion even if the latest triage skipped the update.',
                             'Labels were made by the old, character-truncated triage input; this model sees complete text up to 8192 tokens.',
                             'Attachment changes are not included in the historical source hash.',
                             'Template grouping removes normalized exact duplicates, not all near duplicates.',
                             'Chronological splits follow decision time; recent decisions can come from a single backfill batch.'],
              'productionEnabled': False}
    if dataset_policy:
        report['datasetPolicy'] = {key: dataset_policy[key] for key in
                                  ['labels', 'splitPolicy', 'evaluationSampling', 'limitations'] if key in dataset_policy}
        if 'evaluationSampling' in dataset_policy:
            report['limitations'] = [dataset_policy['labels'], dataset_policy['evaluationSampling'],
                                     *dataset_policy.get('limitations', []),
                                     'Historical labels were generated from the older character-truncated triage input.']
    if (target / 'embedding-summary.json').exists():
        report['resources'] = json.loads((target / 'embedding-summary.json').read_text())
    _, _, strict_classifier, strict_threshold, strict_scores, strict_validation = max(conservative_candidates, key=lambda x: x[:2])
    report['conservativeValidationPolicy'] = {'targetValidationRecall': 1., 'threshold': strict_threshold,
        'classifierC': strict_classifier.C, 'validation': strict_validation,
        'test': metrics(labels[test], strict_scores[test], strict_threshold),
        'note': 'Exploratory stricter policy. Threshold and regularization still use validation only; not a guarantee of production recall.'}
    joblib.dump({'classifier': classifier, 'threshold': threshold, 'encoder': identity['encoder'],
                 'maxTokens': 8192, 'overflowPolicy': 'forward_to_llm', 'datasetSha256': dataset_hash}, target / 'classifier.joblib')
    joblib.dump({'classifier': strict_classifier, 'threshold': strict_threshold, 'encoder': identity['encoder'],
                 'maxTokens': 8192, 'overflowPolicy': 'forward_to_llm', 'datasetSha256': dataset_hash}, target / 'classifier-conservative.joblib')
    atomic_json(target / 'report.json', report)
    # Keep text and error examples private. The review list contains only IDs/scores.
    review = [{'threadId': r['threadId'], 'label': r['label'], 'score': float(scores[i]), 'split': r['split']}
              for i, r in enumerate(rows) if r['split'] == 'test' and r['label'] == 1 and scores[i] < threshold]
    (target / 'false-negatives.json').write_text(json.dumps(review, indent=2))
    print(json.dumps(report, indent=2))


def profile(args):
    rows, digest = load_dataset(args.directory)
    target = args.directory / args.name
    if json.loads((target / 'manifest.json').read_text())['datasetSha256'] != digest:
        raise RuntimeError('Dataset hash mismatch')
    encoder = (BGE if args.name == 'bge' else GTE)(args.fine_tuned)
    lengths = np.load(target / 'token-lengths.npy')
    usable = np.flatnonzero(lengths <= 8192)
    samples = []
    for budget in [128, 512, 2048, 4096, 8192]:
        below = [i for i in usable if lengths[i] <= budget]
        index = max(below, key=lambda i: int(lengths[i])) if below else min(usable, key=lambda i: int(lengths[i]))
        text = rows[index]['text']
        encoder.encode([text])  # warm up this padding bucket / server
        elapsed = []
        for _ in range(3):
            started = time.perf_counter()
            encoder.encode([text])
            elapsed.append(time.perf_counter()-started)
        samples.append({'requestedTokens': budget, 'actualTokens': int(lengths[index]),
                        'medianSeconds': float(np.median(elapsed)), 'maxSeconds': max(elapsed)})
        print(json.dumps({'event': 'profile', 'model': args.name, **samples[-1]}), flush=True)
    atomic_json(target / 'profile.json', {'datasetSha256': digest, 'encoder': encoder.provenance,
        'singleRequestWarmLatency': samples, 'resources': encoder.memory(),
        'note': 'Longest real thread not exceeding each target, three timed runs after warm-up; other Mac services remain active. Avoids crossing a power-of-two inference padding boundary.'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['embed', 'fit', 'profile'])
    parser.add_argument('--directory', type=Path, default=ROOT / '.local-evals/mail-detection')
    parser.add_argument('--name', choices=['gte', 'bge', 'gte-setfit'], required=True)
    parser.add_argument('--fine-tuned', type=Path)
    parser.add_argument('--batch-size', type=int, default=4)
    parser.add_argument('--token-budget', type=int, default=4096)
    parser.add_argument('--target-recall', type=float, default=.99)
    args = parser.parse_args()
    {'embed': embed, 'fit': fit, 'profile': profile}[args.command](args)
