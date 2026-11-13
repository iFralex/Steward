"""Resumable, local-only Qwen/MLX decision-readout experiment.

The MLX worker needs no PyTorch or sklearn. Preparation/reporting use the
existing mail-detection venv. No network access is used by inference.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local-evals/mail-detection-openjev'
MODEL = ROOT / '.local-models/qwen35-08b-mlx4'
MLXPY = ROOT / '.local-evals/mail-detection-mlx-venv/bin/python'
RUNTIME = ROOT / '.local-models/openjev-runtime'
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('USE_TF', '0')
os.environ.setdefault('USE_TORCH', '0')


def write(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, indent=2)); tmp.replace(path)


def resume_records(path):
    if not path.exists(): return []
    data = path.read_bytes(); lines = data.split(b'\n'); records = []; damaged = b''
    nonempty = [i for i, line in enumerate(lines) if line]
    for i in nonempty:
        try: records.append(json.loads(lines[i]))
        except (json.JSONDecodeError, UnicodeDecodeError):
            if i != nonempty[-1]: raise
            damaged = lines[i]
    assert len(records) == len({r['row'] for r in records}), 'Duplicate scoring records'
    if damaged or (data and not data.endswith(b'\n')):
        path.with_suffix('.interrupted-original.bin').write_bytes(data)
        temporary = path.with_suffix('.repair.tmp')
        temporary.write_text(''.join(json.dumps(r)+'\n' for r in records)); temporary.replace(path)
    return records


def prepare():
    import direct as d
    import numpy as np
    rows, digest, _, splits, lengths = d.context()
    laya = json.loads((ROOT / '.local-evals/mail-detection-laya/plan.json').read_text())
    remote = json.loads((ROOT / '.local-evals/mail-detection-followup/research/openjev/qwen-model-info.json').read_text())
    weight = next(v for v in remote['siblings'] if v['rfilename'] == 'model.safetensors')
    info = {'repo': remote['id'], 'revision': remote['sha'], 'weightsSha256': weight['lfs']['sha256']}
    if (MODEL / 'download-provenance.json').exists():
        assert json.loads((MODEL / 'download-provenance.json').read_text()) == info
    OUT.mkdir(exist_ok=True, mode=0o700)
    plan = {'datasetSha256': digest, 'datasetPath': str(d.SOURCE / 'dataset.jsonl'),
        'model': info, 'runtimeRevision': '501da7e6b59c71e1d184a0eb37e36f8cc5bc6354',
        'policy': laya['policy'], 'options': laya['options'], 'splits': splits,
        'gteOverflowRows': np.flatnonzero(lengths > 8192).tolist(),
        'variants': ['choice-full', 'choice-binary', 'choice-full-mean-labels',
                     'choice-binary-mean-labels', 'noul-full', 'noul-binary'],
        'maxTotalPromptTokens': 8192, 'cache': 'adaptive', 'prefillChunkSize': 256,
        'candidateBatchSize': 2, 'generation': False,
        'readout': 'independent candidate yes-token support; full-vocabulary and yes/no normalized',
        'noul': 'one candidate for keep, false criterion describes discard',
        'calibration': 'minimum positive score; expanded bank secondary',
        'allFoldsExploratory': True, 'productionEnabled': False, 'paidCalls': 0}
    path = OUT / 'plan.json'
    if path.exists(): assert json.loads(path.read_text()) == plan
    else: write(path, plan)


def configuration():
    sys.path.insert(0, str(RUNTIME))
    from openjev import ModelConfig
    return ModelConfig(model=str(MODEL), backend='mlx', device='metal',
        n_ctx=8192, cache_strategy='adaptive', prefill_chunk_size=256,
        batch_size=2, score_mode='full', prompt_style='full')


def questions(plan):
    policy = plan['policy']; opts = plan['options']
    return {'choice': {'type': 'choice', 'instructions': policy, 'criteria': opts},
        'swapped': {'type': 'choice', 'instructions': policy, 'criteria': {'A': opts['B'], 'B': opts['A']}},
        'noul': {'type': 'noul', 'instructions': policy, 'criteria': {'true': opts['B'], 'false': opts['A']}}}


def derive_scores(answer):
    import numpy as np
    choices = answer['answers']['choice']['candidates']; swapped = answer['answers']['swapped']['candidates']
    noul = answer['answers']['noul']['candidates']['true']
    def normalized(candidates, positive, key):
        negative = 'A' if positive == 'B' else 'B'
        if key == 'p_positive':
            p = candidates[positive]['log_support']; n = candidates[negative]['log_support']
            return float(np.exp(p - np.logaddexp(p, n)))
        p = candidates[positive][key]; n = candidates[negative][key]
        assert p >= 0 and n >= 0 and p + n > 0
        return p / (p + n)
    full = normalized(choices, 'B', 'p_positive'); binary = normalized(choices, 'B', 'p_positive_given_binary')
    return {'choice-full': full, 'choice-binary': binary,
        'choice-full-mean-labels': (full + normalized(swapped, 'A', 'p_positive')) / 2,
        'choice-binary-mean-labels': (binary + normalized(swapped, 'A', 'p_positive_given_binary')) / 2,
        'noul-full': noul['p_positive'], 'noul-binary': noul['p_positive_given_binary']}


def checks(plan, rows, config, q):
    import numpy as np
    import mlx.core as mx
    import resource
    from openjev import DecisionEngine
    saved = {}
    for path in OUT.glob('scores-*.jsonl'):
        for line in path.open():
            value = json.loads(line); assert value['row'] not in saved; saved[value['row']] = value
    selected = [max((i for i in saved if saved[i]['tokens'] <= b), key=lambda i: saved[i]['tokens'])
                for b in [1024, 4096, 8192]]
    gte_lengths = np.load(ROOT / '.local-evals/mail-detection-v2/gte/token-lengths.npy')
    assert hashlib.file_digest((MODEL / 'model.safetensors').open('rb'), 'sha256').hexdigest() == plan['model']['weightsSha256']
    verified = []; profiles = []
    with DecisionEngine.from_config(config) as e:
        for i in selected:
            answer = e.decide(rows[i]['text'], q).to_dict(); values = derive_scores(answer)
            assert abs(values['choice-full'] - answer['answers']['choice']['probabilities']['B']) < 1e-12
            assert values['noul-full'] == answer['answers']['noul']['noul']
            difference = max(abs(values[n]-saved[i]['scores'][n]) for n in values)
            assert difference < .003, difference
            verified.append({'row': i, 'tokens': saved[i]['tokens'], 'maximumRepeatScoreDelta': difference})
            for kind in ['choice', 'noul']:
                e.decide(rows[i]['text'], {kind: q[kind]})
                mx.reset_peak_memory()
                timings = []
                for _ in range(3):
                    started = time.perf_counter(); single = e.decide(rows[i]['text'], {kind: q[kind]}).to_dict()
                    assert single['usage']['generated_tokens'] == 0
                    timings.append(time.perf_counter()-started); mx.clear_cache()
                profiles.append({'row': i, 'allReadoutPromptMaxTokens': saved[i]['tokens'],
                    'gteBodyTokens': int(gte_lengths[i]),
                    'question': kind, 'seconds': timings, 'p50': float(np.median(timings)),
                    'mlxPeakAllocatedBytes': int(mx.get_peak_memory()),
                    'processPeakRssBytesMac': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
    write(OUT / 'verification.json', {'passed': True, 'publicApiReadoutsVerified': True,
        'cachedScoresRepeated': verified, 'modelWeightsSha256': plan['model']['weightsSha256']})
    write(OUT / 'single-question-profile.json', {'warm': True, 'scoreMode': 'full', 'profiles': profiles})


def worker(command):
    import numpy as np
    plan = json.loads((OUT / 'plan.json').read_text())
    source = Path(plan['datasetPath'])
    assert hashlib.sha256(source.read_bytes()).hexdigest() == plan['datasetSha256']
    rows = [json.loads(line) for line in source.open()]
    ids = sorted(set(i for name, values in plan['splits'].items() if name != 'optimization' for i in values))
    config = configuration(); q = questions(plan)
    from openjev.prompt import compile_plan
    from openjev.types import parse_questions
    parsed = parse_questions(q)
    if command == 'checks':
        return checks(plan, rows, config, q)
    if command == 'preflight':
        from transformers import AutoTokenizer, PreTrainedTokenizerFast
        from openjev.backends.base import HFTokenizer
        try:
            raw = AutoTokenizer.from_pretrained(str(MODEL), local_files_only=True)
        except ValueError as error:
            if 'Tokenizer class TokenizersBackend does not exist' not in str(error): raise
            # The pinned checkpoint's generic fast-tokenizer serialization is
            # readable by Transformers 4.x too; no config file is rewritten.
            raw = PreTrainedTokenizerFast.from_pretrained(str(MODEL), local_files_only=True)
        tokenizer = HFTokenizer(raw)
        lengths = np.zeros(len(rows), dtype=np.int32); overflow = np.ones(len(rows), dtype=bool)
        gte_overflow = set(plan['gteOverflowRows'])
        for i in ids:
            try:
                compiled = compile_plan(rows[i]['text'], parsed, tokenizer, config)
                lengths[i] = max(len(p) for question in compiled.questions for p in question.prompts)
                overflow[i] = i in gte_overflow
            except ValueError as error:
                if 'n_ctx=' not in str(error): raise
                overflow[i] = True
        np.save(OUT / 'lengths.npy', lengths); np.save(OUT / 'overflow.npy', overflow)
        write(OUT / 'preflight.json', {'rows': len(ids), 'forcedForward': int(sum(overflow[i] for i in ids)),
            'fullPromptsCounted': True, 'noTruncation': True})
    else:
        limit = int(command); lower = 0 if limit == 1024 else limit // 2
        lengths = np.load(OUT / 'lengths.npy'); overflow = np.load(OUT / 'overflow.npy')
        path = OUT / f'scores-{limit}.jsonl'
        done = {r['row'] for r in resume_records(path)}
        pending = sorted([i for i in ids if not overflow[i] and i not in done and lower < lengths[i] <= limit],
                         key=lambda i: lengths[i])
        if not pending: return
        import mlx.core as mx
        from openjev import DecisionEngine
        assert hashlib.file_digest((MODEL / 'model.safetensors').open('rb'), 'sha256').hexdigest() == plan['model']['weightsSha256']
        e = DecisionEngine.from_config(config)
        with path.open('a') as output:
            for position, i in enumerate(pending):
                started = time.perf_counter(); answer = e.decide(rows[i]['text'], q).to_dict()
                assert answer['usage']['generated_tokens'] == 0
                values = derive_scores(answer)
                assert all(np.isfinite(v) and 0 <= v <= 1 for v in values.values())
                record = {'row': i, 'tokens': int(lengths[i]), 'scores': values,
                    'secondsAllReadouts': time.perf_counter()-started, 'generatedTokens': 0,
                    'evaluatedInputTokens': answer['usage']['evaluated_input_tokens']}
                output.write(json.dumps(record) + '\n'); output.flush(); mx.clear_cache()
                if position % 25 == 0: print(json.dumps({'bucket': limit, 'completed': position+1, 'pendingAtStart': len(pending)}), flush=True)
        e.close(); mx.clear_cache()


def report():
    import numpy as np
    from run import metrics
    from followup import diagnostic_curve
    plan = json.loads((OUT / 'plan.json').read_text())
    rows = [json.loads(line) for line in Path(plan['datasetPath']).open()]
    y = np.asarray([r['label'] for r in rows]); splits = plan['splits']
    overflow = np.load(OUT / 'overflow.npy'); saved = {}
    for path in OUT.glob('scores-*.jsonl'):
        for line in path.open():
            r = json.loads(line); assert r['row'] not in saved; saved[r['row']] = r
    ids = sorted(set(i for n, v in splits.items() if n != 'optimization' for i in v))
    assert all(overflow[i] or i in saved for i in ids)
    scores = {n: np.ones(len(rows)) for n in plan['variants']}
    for i, r in saved.items():
        for n in scores: scores[n][i] = r['scores'][n]
    for name in ['base-meta', 'tuned-head']:
        v = np.load(ROOT / '.local-evals/mail-detection-followup' / f'{name}-scores.npy').copy()
        v[overflow] = 1.; scores['gte-' + name + '-common-coverage'] = v
    result = {'variants': {}, 'allHistoricalFoldsExploratory': True, 'paidCalls': 0,
        'productionEnabled': False, 'coverage': {'rows': len(ids), 'inferred': len(saved), 'forcedForward': len(ids)-len(saved)}}
    lines = ['# OpenJev/Qwen3.5-0.8B MLX 4 bit', '',
        'Confronto retrospettivo con etichette LLM; nessuna attivazione in produzione.', '',
        '| Readout | Calibrazione | FN outer | FN test | Scarti test |', '|---|---|---:|---:|---:|']
    for name, v in scores.items():
        result['variants'][name] = {}
        for scope, bank in [('calibration', splits['calibration']), ('expanded-bank-exploratory', splits['calibration']+splits['selection'])]:
            threshold = float(min(v[i] for i in bank if y[i]))
            folds = {n: metrics(y[a], v[a], threshold) for n, a in splits.items() if n != 'optimization'}
            result['variants'][name][scope] = {'threshold': threshold, 'folds': folds}
            outer = folds['outer_validation']; test = folds['exploratory_test']
            lines.append(f"| {name} | {scope} | {outer['falseNegative']} | {test['falseNegative']} | {test['llmCallsAvoidedFraction']:.1%} |")
        result['variants'][name]['oracleRecallDiagnostics'] = {n: diagnostic_curve(y[a], v[a], [.99, 1.]) for n, a in splits.items() if n != 'optimization'}
        np.save(OUT / f'{name}-scores.npy', v)
    result['timingAllReadouts'] = {str(limit): {'examples': len(t), 'p50': float(np.median(t)), 'p95': float(np.percentile(t, 95))}
        for limit in [1024, 2048, 4096, 8192]
        if (t := [r['secondsAllReadouts'] for r in saved.values() if (0 if limit == 1024 else limit//2) < r['tokens'] <= limit])}
    lines += ['', 'Full/binary sono due normalizzazioni degli stessi logit. Non sono probabilità calibrate sulla policy.',
        'La media delle etichette scambiate verifica il bias A/B. Noul valuta una sola ipotesi positiva.',
        'I tempi includono tutti i readout: non rappresentano la latenza di una sola domanda.',
        'I riferimenti GTE usano la stessa copertura comune. Overflow inoltrato, nessun troncamento.',
        'La banca ampliata include selection ed è secondaria. Gli allegati richiedono una decisione separata.']
    write(OUT / 'evaluation.json', result); (OUT / 'comparison.md').write_text('\n'.join(lines)+'\n')
    write(OUT / 'status.json', {'state': 'complete', 'productionEnabled': False, 'paidCalls': 0})


def run():
    prepare()
    try:
        for stage in ['preflight', '1024', '2048', '4096', '8192', 'checks']:
            write(OUT / 'status.json', {'state': 'running', 'stage': stage})
            with (OUT / f'{stage}.log').open('a') as log:
                subprocess.run([str(MLXPY), __file__, 'worker', stage], stdout=log, stderr=subprocess.STDOUT, check=True)
        report()
    except BaseException as error:
        write(OUT / 'status.json', {'state': 'error', 'error': str(error)}); raise
    finally:
        subprocess.run(['afplay', '/System/Library/Sounds/Glass.aiff'], check=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('command'); parser.add_argument('stage', nargs='?'); args = parser.parse_args()
    if args.command == 'run': run()
    elif args.command == 'prepare': prepare()
    elif args.command == 'report': report()
    elif args.command == 'worker': worker(args.stage)
