"""Reuse evaluated frozen embeddings only for byte-identical rendered inputs."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from tokenizers import Tokenizer
from run import CACHE, REVISION, atomic_json, load_dataset


def seed(args):
    rows, digest = load_dataset(args.directory)
    old, _ = load_dataset(args.source)
    source = args.source / args.name
    provenance = json.loads((source / 'manifest.json').read_text())['encoder']
    if provenance.get('fineTuned'):
        raise RuntimeError('Only seed frozen encoders, not a different fine-tune')
    original = np.load(source / 'features.npy', mmap_mode='r')
    old_lengths = np.load(source / 'token-lengths.npy')
    by_text = {hashlib.sha256(r['text'].encode()).hexdigest(): i for i, r in enumerate(old)}
    target = args.directory / args.name
    target.mkdir(exist_ok=True, mode=0o700)
    if (target / 'features.npy').exists():
        print(json.dumps({'event': 'seed_skipped_existing', 'model': args.name}))
        return
    model_path = ('models--BAAI--bge-m3/snapshots/5617a9f61b028005a4858fdac845db406aefb181'
                  if args.name == 'bge' else f'models--Alibaba-NLP--gte-multilingual-base/snapshots/{REVISION}')
    tokenizer = Tokenizer.from_file(str(CACHE / model_path / 'tokenizer.json'))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    lengths = np.asarray([len(tokenizer.encode(r['text']).ids) for r in rows])
    vectors = np.lib.format.open_memmap(target / 'features.npy', mode='w+', dtype=np.float32,
                                      shape=(len(rows), original.shape[1]))
    metadata = {}
    for i, row in enumerate(rows):
        key = hashlib.sha256(row['text'].encode()).hexdigest()
        j = by_text.get(key)
        if j is not None:
            assert row['text'] == old[j]['text'] and lengths[i] == old_lengths[j]
            if lengths[i] <= 8192 and np.isfinite(original[j]).all() and abs(np.linalg.norm(original[j])-1) < .01:
                vectors[i] = original[j]
                metadata[str(i)] = {'tokens': int(lengths[i]), 'seededFromTextSha256': key}
    vectors.flush()
    np.save(target / 'token-lengths.npy', lengths)
    atomic_json(target / 'manifest.json', {'datasetSha256': digest, 'encoder': provenance, 'maxTokens': 8192})
    atomic_json(target / 'embedding-metadata.json', metadata)
    print(json.dumps({'event': 'seed_complete', 'model': args.name, 'reused': len(metadata), 'rows': len(rows)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path('.local-evals/mail-detection'))
    parser.add_argument('--name', choices=['gte', 'bge'], required=True)
    seed(parser.parse_args())
