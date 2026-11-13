"""Offline production GTE worker. JSON lines on pipes; no mail/network writes."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1', TOKENIZERS_PARALLELISM='false')
sys.dont_write_bytecode = True


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--manifest', required=True)
    args = parser.parse_args(); raw = Path(args.manifest).read_bytes(); config = json.loads(raw)
    model_id = hashlib.sha256(raw).hexdigest()
    assert config['schemaVersion'] == 1 and config['maxTokens'] == 8192 and config['inputVersion'] == 1
    for package, expected in config['runtimeVersions'].items():
        if importlib.metadata.version(package) != expected: raise RuntimeError('Runtime version changed: '+package)
    for path, expected in config['files'].items():
        if digest(path) != expected: raise RuntimeError('Model file changed: '+Path(path).name)
    os.environ['HF_MODULES_CACHE'] = config['modulesCache']
    os.environ['HF_HUB_CACHE'] = str(Path(config['basePath']).parents[2])
    import numpy as np
    import torch
    from transformers import AutoTokenizer, AutoModel
    from safetensors.torch import load_file
    # Calibration used this backend/precision; never silently substitute CPU.
    if not torch.backends.mps.is_available(): raise RuntimeError('Evaluated MPS backend unavailable')
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(config['basePath'], local_files_only=True)
    model = AutoModel.from_pretrained(config['basePath'], trust_remote_code=True, code_revision=config['codeRevision'],
        cache_dir=str(Path(config['basePath']).parents[2]), local_files_only=True, attn_implementation='sdpa', torch_dtype=torch.float16).to('mps').eval()
    adapter_config = json.loads(Path(config['adapterConfig']).read_text())
    assert adapter_config['baseRevision'] == config['baseRevision'] and adapter_config['codeRevision'] == config['codeRevision']
    updates = load_file(config['adapterWeights'])
    expected = {name for name, _ in model.named_parameters() if any(name.startswith(f'encoder.layer.{layer}.') for layer in adapter_config['updatedLayers'])}
    assert set(updates) == expected
    model.load_state_dict(updates, strict=False); del updates
    coef = np.asarray(config['classifier']['coef'], dtype=np.float64)
    intercept = float(config['classifier']['intercept']); threshold = float(config['threshold'])
    assert coef.shape == (768,) and np.isfinite(coef).all() and math.isfinite(intercept) and 0 < threshold < 1
    print(json.dumps({'ready': True, 'modelId': model_id, 'backend': 'mps'}), flush=True)
    for line in sys.stdin:
        request = {}; result = {'route': 'llm', 'reason': 'inference_error'}
        try:
            request = json.loads(line)
            if request['policyHash'] != config['policyHash']:
                result = {'route': 'llm', 'reason': 'policy_changed'}
            else:
                text = request['text']
                tokens = len(tokenizer(text, truncation=False, add_special_tokens=True, verbose=False)['input_ids'])
                if tokens > config['maxTokens']:
                    result = {'route': 'llm', 'reason': 'context_overflow', 'tokens': tokens}
                else:
                    bucket = min(8192, max(128, 2**math.ceil(math.log2(max(tokens, 1)))))
                    encoded = tokenizer([text], padding='max_length', max_length=bucket, truncation=False, return_tensors='pt').to('mps')
                    with torch.inference_mode():
                        hidden = model(**encoded).last_hidden_state[:, 0]
                        features = torch.nn.functional.normalize(hidden.float(), dim=-1).cpu().numpy().astype(np.float64)[0]
                    logit = float(features @ coef + intercept)
                    probability = 1/(1+math.exp(-logit)) if logit >= 0 else math.exp(logit)/(1+math.exp(logit))
                    if not math.isfinite(probability): raise RuntimeError('Non-finite score')
                    result = {'route': 'discard' if probability < threshold else 'llm', 'reason': 'scored',
                        'score': probability, 'threshold': threshold, 'tokens': tokens}
                    del hidden, features, encoded
                    torch.mps.synchronize(); torch.mps.empty_cache()
        except Exception as error:
            print('[mail-gte] '+type(error).__name__, file=sys.stderr, flush=True)
        print(json.dumps({'id': request.get('id'), 'modelId': model_id, **result}), flush=True)


if __name__ == '__main__': main()
