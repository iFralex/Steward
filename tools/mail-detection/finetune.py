"""Bounded SetFit contrastive pilot using only the historical training split."""
import argparse
import collections
from contextlib import nullcontext
from functools import partial
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import time

import numpy as np
from run import CACHE, CODE_REVISION, REVISION, ROOT, atomic_json, load_dataset

import torch
from datasets import Dataset
from sentence_transformers import SentenceTransformer, models
from setfit import SetFitModel, Trainer, TrainingArguments
from sklearn.linear_model import LogisticRegression
from transformers import TrainerCallback
from unittest.mock import patch
import setfit.trainer as setfit_trainer


class MixedPairsTrainer(Trainer):
    """Mix nearest cross-label negatives with ordinary random training pairs."""
    def __init__(self, *args, frozen_features, example_ids, seed, pair_count, **kwargs):
        self.features = frozen_features
        self.example_ids = example_ids
        self.pair_seed = seed
        self.pair_count = pair_count
        self.pair_manifest = []
        super().__init__(*args, **kwargs)

    def get_dataset(self, x, y, args, max_pairs=-1):
        rng = random.Random(self.pair_seed)
        features = self.features
        similarity = features @ features.T
        labels = np.asarray(y)
        pairs = []
        for step in range(self.pair_count):
            anchor = rng.randrange(len(x))
            positive = step % 2 == 0
            candidates = np.flatnonzero((labels == labels[anchor]) if positive else (labels != labels[anchor]))
            candidates = candidates[candidates != anchor]
            # Half of negative pairs are hard, and the remainder are random.
            hard = not positive and step % 4 == 1
            partner = int(candidates[np.argmax(similarity[anchor, candidates])]) if hard else int(rng.choice(candidates.tolist()))
            pairs.append({'sentence_1': x[anchor], 'sentence_2': x[partner], 'label': float(positive)})
            self.pair_manifest.append({'leftRow': self.example_ids[anchor], 'rightRow': self.example_ids[partner],
                                       'sameLabel': positive, 'hardNegative': hard})
        return Dataset.from_list(pairs), args.loss(self.model.model_body)

class BucketedTransformer(models.Transformer):
    """Keep MPS graph shapes bounded during contrastive fine-tuning as well."""
    def tokenize(self, texts, padding=True):
        encoded = super().tokenize(texts, padding=padding)
        length = encoded['input_ids'].shape[1]
        bucket = min(8192, max(128, ((length + 511) // 512) * 512))
        for key, tensor in encoded.items():
            if tensor.ndim == 2:
                value = self.tokenizer.pad_token_id if key == 'input_ids' else 0
                encoded[key] = torch.nn.functional.pad(tensor, (0, bucket-length), value=value)
        return encoded


class Progress(TrainerCallback):
    def __init__(self, min_free_gib=2, device='mps'):
        self.min_free_gib = min_free_gib
        self.device = device

    def on_step_end(self, args, state, control, **kwargs):
        if shutil.disk_usage(ROOT).free < self.min_free_gib * 1024**3:
            raise RuntimeError(f'Training stopped below {self.min_free_gib:g} GiB free to preserve room for macOS and model export.')

    def on_log(self, args, state, control, logs=None, **kwargs):
        values = {key: value for key, value in (logs or {}).items() if isinstance(value, (int, float))}
        values['freeDiskGiB'] = round(shutil.disk_usage(ROOT).free / 1024**3, 3)
        if self.device == 'mps':
            values['mpsDriverAllocatedBytes'] = torch.mps.driver_allocated_memory()
        print(json.dumps({'event': 'setfit_training', 'step': state.global_step, **values}), flush=True)
        if self.device == 'mps':
            torch.mps.empty_cache()


def main(args):
    if args.adapter_only is None:
        args.adapter_only = args.hard_pairs and bool(args.train_last_layers)
    if args.adapter_only and not args.train_last_layers:
        raise ValueError('Partial export requires --train-last-layers')
    rows, digest = load_dataset(args.directory)
    prior_manifest = args.directory / 'setfit-training.json'
    weights_file = 'adapter.safetensors' if args.adapter_only else 'model.safetensors'
    if prior_manifest.exists() and (args.directory / 'setfit-model' / weights_file).exists():
        prior = json.loads(prior_manifest.read_text())
        if (prior['datasetSha256'] != digest or prior['steps'] != args.steps
                or prior.get('requestedExamples', 256) != args.examples
                or prior.get('trainLastLayers', 0) != args.train_last_layers
                or prior.get('hardPairs', False) != args.hard_pairs
                or prior.get('adapterOnly', False) != args.adapter_only):
            raise RuntimeError('An existing pilot belongs to different training settings; use another --directory.')
        print(json.dumps({'event': 'setfit_already_complete', **prior}), flush=True)
        return
    required_gib = 1.4 if args.device == 'cpu' and args.adapter_only else 2.5 if args.train_last_layers else 10
    if shutil.disk_usage(ROOT).free < required_gib * 1024**3:
        raise RuntimeError(f'At least {required_gib} GiB free is required for this training configuration.')
    lengths = np.load(args.directory / 'gte/token-lengths.npy')
    eligible = [i for i, row in enumerate(rows) if row['split'] == 'train' and lengths[i] <= 8192]
    rng = random.Random(20261103)
    selected = []
    for label in [0, 1]:
        candidates = [i for i in eligible if rows[i]['label'] == label]
        buckets = collections.defaultdict(list)
        for i in candidates:
            buckets[min(3, int(lengths[i]) // 2048)].append(i)
        chosen = []
        for bucket in buckets.values():
            quota = round(args.examples / 2 * len(bucket) / len(candidates))
            chosen.extend(rng.sample(bucket, min(len(bucket), quota)))
        selected.extend(chosen[:args.examples // 2])
    rng.shuffle(selected)
    device = args.device if args.device != 'auto' else 'mps' if torch.backends.mps.is_available() else 'cpu'
    if device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('Requested MPS device is unavailable')
    if device == 'cpu':
        os.environ['ACCELERATE_USE_CPU'] = 'true'
    if device == 'mps':
        torch.mps.set_per_process_memory_fraction(.7)
    torch.set_num_threads(4)
    torch.manual_seed(20261103)
    path = str(CACHE / f'models--Alibaba-NLP--gte-multilingual-base/snapshots/{REVISION}')
    transformer = BucketedTransformer(path, max_seq_length=8192, cache_dir=str(CACHE),
        config_args={'trust_remote_code': True, 'code_revision': CODE_REVISION, 'local_files_only': True},
        model_args={'trust_remote_code': True, 'code_revision': CODE_REVISION,
                    'local_files_only': True, 'attn_implementation': 'sdpa'},
        tokenizer_args={'local_files_only': True})
    # Most parameters are the multilingual vocabulary matrix. Keep its lexical
    # knowledge fixed and optimize the transformer layers on this small pilot.
    transformer.auto_model.get_input_embeddings().requires_grad_(False)
    layers = transformer.auto_model.encoder.layer
    if args.train_last_layers:
        if not 1 <= args.train_last_layers <= len(layers):
            raise ValueError('train-last-layers must fit the encoder depth')
        transformer.auto_model.requires_grad_(False)
        for layer in layers[-args.train_last_layers:]:
            layer.requires_grad_(True)
    transformer.auto_model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
    body = SentenceTransformer(modules=[transformer, models.Pooling(768, pooling_mode='cls'), models.Normalize()], device=device)
    body.float()
    trainable = sum(p.numel() for p in body.parameters() if p.requires_grad)
    model = SetFitModel(model_body=body, model_head=LogisticRegression(max_iter=2000), normalize_embeddings=True)
    dataset = Dataset.from_dict({'text': [rows[i]['text'] for i in selected], 'label': [rows[i]['label'] for i in selected]})
    training_args = TrainingArguments(output_dir=str(args.directory / 'setfit-work'), batch_size=(1, 4),
        max_steps=args.steps, num_iterations=4, sampling_strategy='undersampling',
        body_learning_rate=1e-5, max_length=8192, use_amp=False,
        logging_steps=5, report_to='none', save_strategy='no', eval_strategy='no',
        show_progress_bar=False, seed=20261103)
    print(json.dumps({'event': 'setfit_start', 'examples': len(selected), 'maxSteps': args.steps,
                      'maxTokens': int(max(lengths[selected])), 'device': device,
                      'trainableParameters': trainable, 'trainLastLayers': args.train_last_layers}), flush=True)
    started = time.perf_counter()
    trainer_options = dict(model=model, args=training_args, train_dataset=dataset,
                           callbacks=[Progress(1.25 if args.train_last_layers else 2, device=device)])
    # SetFit 1.1.3 builds fresh ST arguments without exposing use_cpu. Passing
    # ACCELERATE_USE_CPU alone is insufficient on macOS: Transformers may still
    # select MPS. Override this constructor only during local trainer creation.
    cpu_arguments = partial(setfit_trainer.SentenceTransformerTrainingArguments, use_cpu=True)
    with (patch.object(setfit_trainer, 'SentenceTransformerTrainingArguments', cpu_arguments)
          if device == 'cpu' else nullcontext()):
        if args.hard_pairs:
            frozen = np.load(args.directory / 'gte/features.npy')[selected]
            if not np.allclose(np.linalg.norm(frozen, axis=1), 1, atol=.01):
                raise RuntimeError('Hard pairs require complete frozen training embeddings')
            trainer = MixedPairsTrainer(**trainer_options, frozen_features=frozen,
                                        example_ids=selected, seed=20261104, pair_count=args.steps)
        else:
            trainer = Trainer(**trainer_options)
    if trainer.st_trainer.args.device.type != device:
        raise RuntimeError('Trainer device differs from the requested training device')
    # Train only the encoder here. run.py fits the logistic head on the full,
    # identical training split for both the frozen and fine-tuned encoders.
    trainer.train_embeddings(dataset['text'], dataset['label'])
    if args.hard_pairs:
        assert all(rows[p[k]]['split'] == 'train' for p in trainer.pair_manifest for k in ['leftRow', 'rightRow'])
        atomic_json(args.directory / 'setfit-pairs.json', trainer.pair_manifest)
    model.model_body.half()
    # Serialize as the standard Transformer module; bucketing changes padding,
    # not weights, and inference has its own equivalent bucketing implementation.
    model.model_body[0].__class__ = models.Transformer
    output = args.directory / 'setfit-model'
    if args.adapter_only:
        if not args.train_last_layers:
            raise ValueError('Partial export requires --train-last-layers')
        from safetensors.torch import save_file
        output.mkdir(exist_ok=True)
        auto_model = model.model_body[0].auto_model
        updates = {name: parameter.detach().cpu().contiguous() for name, parameter in auto_model.named_parameters()
                   if parameter.requires_grad}
        assert all(torch.isfinite(parameter).all() for parameter in updates.values())
        save_file(updates, str(output / 'adapter.safetensors'))
        atomic_json(output / 'adapter_config.json', {'baseRevision': REVISION, 'codeRevision': CODE_REVISION,
                    'updatedLayers': list(range(len(layers) - args.train_last_layers, len(layers))),
                    'maxSequenceLength': 8192})
    else:
        model.model_body.save(str(output), safe_serialization=True)
    manifest = {'datasetSha256': digest, 'sourceRevision': REVISION, 'codeRevision': CODE_REVISION,
                'trainingExamples': len(selected), 'requestedExamples': args.examples,
                'steps': args.steps, 'seconds': time.perf_counter()-started,
                'maxSequenceLength': 8192, 'onlyTrainingSplitUsed': True,
                'inputEmbeddingMatrixFrozen': True, 'trainableParameters': trainable,
                'trainLastLayers': args.train_last_layers,
                'hardPairs': args.hard_pairs,
                'adapterOnly': args.adapter_only,
                'trainingSeed': 20261103, 'pairSeed': 20261104 if args.hard_pairs else None,
                'trainingDevice': device,
                'learningRate': 1e-5, 'batchSize': 1,
                'trainingScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'note': 'Bounded SetFit pilot, not an exhaustive hyperparameter search.'}
    with (output / weights_file).open('rb') as stream:
        manifest['outputWeightsSha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
    if args.hard_pairs:
        manifest['pairedTrainingExamples'] = len({p[k] for p in trainer.pair_manifest for k in ['leftRow', 'rightRow']})
        manifest['pairCounts'] = {'sameLabel': sum(p['sameLabel'] for p in trainer.pair_manifest),
                                  'hardNegative': sum(p['hardNegative'] for p in trainer.pair_manifest),
                                  'randomNegative': sum(not p['sameLabel'] and not p['hardNegative'] for p in trainer.pair_manifest)}
    atomic_json(args.directory / 'setfit-training.json', manifest)
    print(json.dumps({'event': 'setfit_complete', **manifest}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=ROOT / '.local-evals/mail-detection')
    parser.add_argument('--examples', type=int, default=256)
    parser.add_argument('--steps', type=int, default=80)
    parser.add_argument('--hard-pairs', action='store_true')
    parser.add_argument('--device', choices=['auto', 'mps', 'cpu'], default='auto')
    parser.add_argument('--adapter-only', action=argparse.BooleanOptionalAction, default=None,
                        help='Export only updated layers; defaults on for hard-pair experiments.')
    parser.add_argument('--train-last-layers', type=int, default=0,
                        help='Fine-tune only the last N layers to reduce optimizer and activation memory; 0 trains all layers.')
    main(parser.parse_args())
