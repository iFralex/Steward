"""Local, resumable, policy-conditioned benchmark. Never sends mail externally."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

os.environ.setdefault('USE_TF', '0')
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('LAYA_MPS_AMP_MIN_ROWS', '1')
import numpy as np
import direct as d
from run import atomic_json, metrics

OUT = d.ROOT / '.local-evals/mail-detection-laya'
MODEL = d.ROOT / '.local-models/laya-multilingual'
RUNTIME = d.ROOT / '.local-models/laya-runtime'
sys.path.insert(0, str(RUNTIME))

# Fixed before any candidate scores are observed. Output formatting/categories
# are irrelevant to this binary target; the retention rules are preserved.
POLICY = '''Does this email thread contain durable PERSONAL knowledge worth retaining?
Keep the user's own requests, commitments, important documents, personal facts,
decisions and relationships. The user must be personally involved: sender, direct
recipient, response to their question, or explicitly about their own life, work,
money, health, documents or relationships. Generic discussions by other people on
a subscribed mailing list are noise. Marketing, promotions, discounts, sales,
time-limited offers, event invites and generic announcements are noise.
Service/transactional notifications, confirmations, onboarding, application-funnel
steps, verification prompts, reminders and status updates are noise UNLESS they
carry a durable fact such as an account/user code, IBAN, credentials or a real
document/statement, OR require an action or appointment still in the FUTURE
relative to Today in the supplied header. A past-action reminder is noise.
Old requests and commitments can remain historical personal knowledge, rather
than live tasks. Judge dates relative to the supplied Today, not the current date.
Evaluate the whole conversation. Decide promoteMail only; attachment ingestion
is a separate decision and must not determine the answer to this question.'''
OPTIONS = {'A': 'Discard: no durable personal knowledge in the email thread.',
           'B': 'Keep: durable personal knowledge in the email thread.'}


def context():
    OUT.mkdir(exist_ok=True, mode=0o700)
    rows, digest, _, splits, gte_lengths = d.context()
    plan = {'datasetSha256': digest, 'modelRevision': '1720e3e3357cfe1e281542e223f8273b0890ca34',
            'runtimeRevision': '634f80d96b86cda3ddd4222426e0ee45735f357b',
            'policy': POLICY, 'options': OPTIONS, 'maxTokensIncludingQuestion': 8192,
            'headMaxTokens': 1536, 'precision': 'FP32 weights and computation; autocast disabled',
            'folds': [n for n in splits if n != 'optimization'],
            'variants': ['normal', 'reversed', 'mean-orders'],
            'threshold': 'minimum positive score in calibration; expanded bank is secondary',
            'overflow': 'forward if either GTE or Laya exceeds its budget; never truncate',
            'scores': 'raw choice logits softmax, unrounded, checkpoint temperature 1',
            'allHistoricalFoldsExploratory': True, 'productionEnabled': False, 'paidCalls': 0}
    path = OUT / 'plan.json'
    if path.exists():
        assert json.loads(path.read_text()) == plan
    else:
        atomic_json(path, plan)
    return rows, splits, gte_lengths


def agent(device=None):
    import torch
    from laya import Agent
    torch.set_num_threads(4)
    a = Agent(str(MODEL), device=device or os.environ.get('LAYA_BENCHMARK_DEVICE', 'mps'), compile=False, fast=False)
    # FP16 overflowed beyond 1k in the initial attempt; BF16 also differed
    # materially from FP32. Keep the checkpoint's original FP32 computation.
    a.amp_enabled = False
    a.dtype = torch.float32
    if a.device.type == 'cpu':
        # The public checkpoint stores this frozen table in FP16. Its FP32
        # expansion is exactly reversible; keep compact storage and return the
        # identical FP32 lookup values before normalization/attention.
        embeddings = a.model.encoder.embeddings
        table = embeddings.tok_embeddings
        for start in range(0, len(table.weight), 4096):
            part = table.weight.detach()[start:start+4096]
            assert torch.equal(part, part.half().float())
        table.weight.data = table.weight.data.half()
        table.register_forward_hook(lambda module, inputs, output: output.float())
        # Transformers infers mask dtype from its first parameter. Keep the
        # FP32 norm first; changing registration order changes no computation.
        embeddings._modules = {'norm': embeddings.norm,
            **{key: value for key, value in embeddings._modules.items() if key != 'norm'}}
        assert a.model.encoder.dtype == torch.float32
    return a


def questions(a):
    q = {'type': 'choice', 'instructions': POLICY, 'criteria': OPTIONS}
    return {name: a._to_internal({**q, 'option_order': order})
            for name, order in [('normal', [0, 1]), ('reversed', [1, 0])]}


def preflight(a, text, q):
    from laya.common import build_head, encode_text
    for question in q.values():
        head, _, stats = build_head(a.tok, question, 1536, option_order=question['option_order'])
        instruction = encode_text(a.tok, 'choice question: ' + POLICY, add_special_tokens=False)['input_ids']
        assert head[1:1 + len(instruction)] == instruction, 'Policy was truncated'
        assert stats['options_distinct'] == 2 and stats['tokens_per_option'] is None
    return a._encode_state(text, list(q), q, max_len=8192, head_max_len=1536)


def prepare():
    rows, splits, lengths = context()
    a = agent(); q = questions(a)
    indices = sorted(set(i for n in splits if n != 'optimization' for i in splits[n]))
    lengths_laya = np.zeros(len(rows), dtype=np.int32)
    overflow = np.ones(len(rows), dtype=bool)
    for i in indices:
        items = preflight(a, rows[i]['text'], q)
        lengths_laya[i] = max(len(v['ids']) for v in items)
        overflow[i] = lengths[i] > 8192 or any(v['state_stats']['truncated'] for v in items)
    np.save(OUT / 'lengths.npy', lengths_laya)
    np.save(OUT / 'overflow.npy', overflow)
    atomic_json(OUT / 'preflight.json', {'evaluatedRows': len(indices),
        'forcedForward': sum(bool(overflow[i]) for i in indices),
        'weights': json.loads((MODEL / 'download-provenance.json').read_text()),
        'policyFullyPreserved': True, 'optionsFullyPreserved': True,
        'noPrivateNetworkRequests': True})
    print('Preflight complete', flush=True)


def bucket(limit, maximum_rows=None, longest_first=False):
    import torch
    from laya.common import collate_items
    rows, splits, gte_lengths = context()
    lengths = np.load(OUT / 'lengths.npy'); overflow = np.load(OUT / 'overflow.npy')
    ids = sorted(set(i for n in splits if n != 'optimization' for i in splits[n]))
    path = OUT / f'scores-{limit}.jsonl'
    done = {json.loads(line)['row'] for line in path.open()} if path.exists() else set()
    lower = 0 if limit == 512 else limit // 2
    pending = [i for i in ids if i not in done and not overflow[i] and lower < lengths[i] <= limit]
    pending = sorted(pending, key=lambda i: lengths[i], reverse=longest_first)
    if maximum_rows is not None: pending = pending[:maximum_rows]
    if not pending:
        return
    a = agent(); q = questions(a)
    with path.open('a') as output, torch.inference_mode():
        for position, i in enumerate(pending):
            started = time.perf_counter()
            items = preflight(a, rows[i]['text'], q)
            assert not any(v['state_stats']['truncated'] for v in items)
            batch = collate_items([items], a.tok.pad_token_id)
            # Bound MPS graph variants; natural lengths create hundreds of
            # compiled graphs and excessive swap. Padding is fully masked.
            if a.device.type == 'mps':
                missing = limit - batch['input_ids'].shape[1]
                batch['input_ids'] = torch.nn.functional.pad(batch['input_ids'], (0, missing), value=a.tok.pad_token_id)
                batch['attention_mask'] = torch.nn.functional.pad(batch['attention_mask'], (0, missing), value=0)
            if limit >= 4096:
                # Score the two orders sequentially at 8k to halve activation
                # memory; the semantic inputs and score computation are identical.
                parts = []
                for j in range(2):
                    one = {key: value[j:j+1] for key, value in batch.items()}
                    raw, _ = a._forward(one); parts.append(raw)
                    torch.mps.empty_cache() if a.device.type == "mps" else None
                logits = np.concatenate(parts, axis=0)
            else:
                logits, _ = a._forward(batch)
            assert np.isfinite(logits).all()
            z = logits[:, :2].astype(np.float64)
            p = np.exp(z - z.max(axis=1, keepdims=True)); p /= p.sum(axis=1, keepdims=True)
            # Normal slots A,B; reversed slots B,A. Same semantic positive B.
            result = {'row': i, 'normal': float(p[0, 1]), 'reversed': float(p[1, 0]),
                      'tokens': int(lengths[i]), 'secondsBothOrders': time.perf_counter()-started,
                      'deviceAfterForward': str(a.device),
                      'observedMpsDriverBytes': int(torch.mps.driver_allocated_memory()) if a.device.type == 'mps' else None}
            output.write(json.dumps(result) + '\n'); output.flush()
            torch.mps.empty_cache() if a.device.type == "mps" else None
            if position % 25 == 0:
                print(json.dumps({'bucket': limit, 'completed': position + 1, 'pendingAtStart': len(pending)}), flush=True)


def report():
    rows, splits, _ = context(); y = np.asarray([r['label'] for r in rows])
    overflow = np.load(OUT / 'overflow.npy')
    saved = {}
    for path in OUT.glob('scores-*.jsonl'):
        for line in path.open():
            value = json.loads(line); assert value['row'] not in saved
            saved[value['row']] = value
    ids = sorted(set(i for n in splits if n != 'optimization' for i in splits[n]))
    assert all(overflow[i] or i in saved for i in ids), 'Incomplete benchmark'
    scores = {n: np.ones(len(rows)) for n in ['normal', 'reversed', 'mean-orders']}
    for i, result in saved.items():
        scores['normal'][i] = result['normal']; scores['reversed'][i] = result['reversed']
        scores['mean-orders'][i] = (result['normal'] + result['reversed']) / 2
    # Same forced-forward coverage for the reference models: the comparison
    # cannot reward one tokenizer for excluding difficult, longer documents.
    for name in ['base-meta', 'tuned-head']:
        score = np.load(d.ROOT / '.local-evals/mail-detection-followup' / f'{name}-scores.npy').copy()
        score[overflow] = 1.
        scores['gte-' + name + '-common-coverage'] = score
    result = {'exploratory': True, 'productionEnabled': False, 'variants': {}}
    for name, score in scores.items():
        result['variants'][name] = {}
        for scope, bank in [('calibration', splits['calibration']),
                            ('expanded-bank-exploratory', splits['calibration'] + splits['selection'])]:
            threshold = float(min(score[i] for i in bank if y[i]))
            result['variants'][name][scope] = {'threshold': threshold,
                'folds': {n: metrics(y[v], score[v], threshold) for n, v in splits.items() if n != 'optimization'}}
        np.save(OUT / f'{name}-scores.npy', score)
    result['orderSensitivity'] = {'meanAbsoluteProbabilityDelta': float(np.mean([abs(v['normal']-v['reversed']) for v in saved.values()])),
        'argmaxDisagreements': sum((v['normal'] >= .5) != (v['reversed'] >= .5) for v in saved.values())}
    result['coverage'] = {'rows': len(ids), 'inferred': len(saved), 'forcedForward': len(ids)-len(saved)}
    result['runtimeNotes'] = {'padding': 'MPS uses masked bucket padding except initial rows; CPU uses natural lengths',
        'cpuFallback': '4k GPU ENOSPC; remaining long cases run on CPU with an independently checked score match',
        'cpuVocabulary': 'original FP16 storage, verified lossless round trip; lookup and all attention remain FP32',
        'mlxAttempt': 'Installation failed with ENOSPC; incomplete environment removed; Qwen weights not downloaded',
        'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    result['matchedRecallOracleDiagnostics'] = {}
    from followup import diagnostic_curve
    for name, score in scores.items():
        result['matchedRecallOracleDiagnostics'][name] = {
            n: diagnostic_curve(y[v], score[v], [.99, 1.])
            for n, v in splits.items() if n != 'optimization'}
    result['timingBothOrders'] = {'p50': float(np.median([v['secondsBothOrders'] for v in saved.values()])),
                                'p95': float(np.percentile([v['secondsBothOrders'] for v in saved.values()], 95))}
    result['timingByBucketBothOrders'] = {}
    for limit in [512, 1024, 2048, 4096, 8192]:
        lower = 0 if limit == 512 else limit // 2
        timings = [v['secondsBothOrders'] for v in saved.values() if lower < v['tokens'] <= limit]
        result['timingByBucketBothOrders'][str(limit)] = {'examples': len(timings),
            'p50': float(np.median(timings)), 'p95': float(np.percentile(timings, 95))}
    atomic_json(OUT / 'evaluation.json', result)
    lines = ['# Laya multilingue: benchmark locale', '',
        'Confronto retrospettivo su etichette storiche LLM, non verità umana. Nessuna attivazione in produzione.', '',
        '| Variante | Calibrazione | FN vecchio outer | FN vecchio test | Scarti vecchio test |',
        '|---|---|---:|---:|---:|']
    for name, scopes in result['variants'].items():
        for scope, value in scopes.items():
            outer = value['folds']['outer_validation']; test = value['folds']['exploratory_test']
            lines.append(f"| {name} | {scope} | {outer['falseNegative']} | {test['falseNegative']} | {test['llmCallsAvoidedFraction']:.1%} |")
    lines += ['', 'La variante a due ordini usa due forward per thread. L’ordine non viene scelto sui fold finali.',
        'Gli overflow includono l’intera policy e vengono inoltrati; nessun thread viene tagliato.',
        'La decisione riguarda solo promoteMail: gli allegati richiedono un percorso indipendente.', '',
        'Policy adattata a una domanda binaria, senza schema JSON/categorie/note del modello generativo.',
        'I riferimenti GTE vengono ricalibrati con la stessa copertura comune e la stessa banca di positivi.',
        'Dopo ENOSPC nella fascia 4k, i casi lunghi mancanti usano CPU FP32 e lunghezze naturali; parità numerica verificata con GPU.',
        'Dettagli di copertura, sensibilità all’ordine e tempi: evaluation.json.',
        'La banca ampliata include selection e resta un’analisi secondaria esplorativa.']
    (OUT / 'comparison.md').write_text('\n'.join(lines) + '\n')
    atomic_json(OUT / 'status.json', {'state': 'complete', 'productionEnabled': False, 'paidCalls': 0})


def verify():
    import torch
    rows, splits, gte_lengths = context()
    saved = {}
    for path in OUT.glob('scores-*.jsonl'):
        for line in path.open():
            value = json.loads(line); assert value['row'] not in saved
            saved[value['row']] = value
    a = agent()
    assert a.model.encoder.config.global_rope_theta == 160000
    assert a.model.encoder.config.local_rope_theta == 160000
    q = {'normal': {'type': 'choice', 'instructions': POLICY, 'criteria': OPTIONS, 'option_order': [0, 1]},
         'reversed': {'type': 'choice', 'instructions': POLICY, 'criteria': OPTIONS, 'option_order': [1, 0]}}
    checks = []
    ordered = sorted(saved, key=lambda i: saved[i]['tokens'])
    selected = [max((i for i in ordered if saved[i]['tokens'] <= b), key=lambda i: saved[i]['tokens'])
                for b in [512, 4096, 8192]]
    profiles = []
    with torch.inference_mode():
        for i in selected:
            differences = {}
            for name, question in q.items():
                public = a.predict(rows[i]['text'], {name: question}, max_len=8192, head_max_len=1536)
                assert not public['usage'].get('truncated')
                differences[name] = abs(public['answers'][name]['probabilities']['B'] - saved[i][name])
                torch.mps.empty_cache() if a.device.type == "mps" else None
            assert max(differences.values()) < .003, differences
            checks.append({'row': i, 'tokens': saved[i]['tokens'], 'publicApiScoreDelta': differences})
            torch.mps.empty_cache() if a.device.type == "mps" else None
            durations = []
            for _ in range(3):
                started = time.perf_counter()
                answer = a.predict(rows[i]['text'], {'normal': q['normal']}, max_len=8192, head_max_len=1536)
                assert not answer['usage'].get('truncated')
                durations.append(time.perf_counter()-started)
                torch.mps.empty_cache() if a.device.type == "mps" else None
            profiles.append({'row': i, 'totalLayaTokens': saved[i]['tokens'],
                'gteBodyTokens': int(gte_lengths[i]), 'oneChoiceApiSeconds': durations,
                'p50': float(np.median(durations)), 'device': str(a.device), 'precision': 'FP32'})
    evaluation = json.loads((OUT / 'evaluation.json').read_text())
    assert len(saved) == evaluation['coverage']['inferred']
    overflow = np.load(OUT / 'overflow.npy')
    assert all(not overflow[i] for i in saved)
    for variant in evaluation['variants'].values():
        for scope, value in variant.items():
            banks = ['calibration'] if scope == 'calibration' else ['calibration', 'selection']
            assert all(value['folds'][n]['falseNegative'] == 0 for n in banks)
    atomic_json(OUT / 'verification.json', {'passed': True, 'publicApiComparisons': checks,
        'weightsSha256': hashlib.file_digest((MODEL / 'model.safetensors').open('rb'), 'sha256').hexdigest(),
        'ropeCompatibilityVerified': True, 'overflowNeverInferred': True, 'calibrationZeroFnVerified': True})
    atomic_json(OUT / 'single-question-profile.json', {'warm': True, 'oneQuestionPerCall': True, 'profiles': profiles})


def proof():
    """Bounded CPU-only numerical check, not a substitute for the full benchmark."""
    import torch
    from laya.common import collate_items
    rows, splits, _ = context()
    lengths = np.load(OUT / 'lengths.npy')
    overflow = np.load(OUT / 'overflow.npy')
    eligible = [i for i in splits['calibration'] if not overflow[i] and lengths[i] <= 1024]
    chosen = [i for label in [0, 1] for i in sorted(eligible) if rows[i]['label'] == label]
    chosen = ([i for i in chosen if rows[i]['label'] == 0][:8] +
              [i for i in chosen if rows[i]['label'] == 1][:8])
    a = agent(device='cpu'); q = questions(a); records = []
    with torch.inference_mode():
        for i in chosen:
            items = preflight(a, rows[i]['text'], q)
            assert max(len(v['ids']) for v in items) <= 1024
            assert not any(v['state_stats']['truncated'] for v in items)
            started = time.perf_counter()
            logits, _ = a._forward(collate_items([items], a.tok.pad_token_id))
            assert np.isfinite(logits).all()
            z = logits[:, :2].astype(np.float64); p = np.exp(z-z.max(axis=1, keepdims=True)); p /= p.sum(axis=1, keepdims=True)
            records.append({'row': i, 'tokens': int(lengths[i]), 'normal': float(p[0, 1]),
                'reversed': float(p[1, 0]), 'seconds': time.perf_counter()-started})
    atomic_json(OUT / 'cpu-fp32-proof.json', {'passed': True, 'records': records,
        'device': 'cpu', 'precision': 'FP32', 'maxTotalTokens': 1024,
        'sampling': 'first eight historical negatives and positives in eligible calibration indices',
        'qualityBenchmark': False, 'paidCalls': 0, 'privateDataUploaded': False})
    print('Bounded CPU proof passed:', len(records), 'threads', flush=True)


def proof_long():
    import torch
    import resource
    from laya.common import collate_items
    rows, _, _ = context()
    path = OUT / 'scores-4096.jsonl'
    records = []; bad = []
    for line in path.open():
        try: records.append(json.loads(line))
        except json.JSONDecodeError: bad.append(line)
    if bad:
        (OUT / 'interrupted-4096-tail.txt').write_text(''.join(bad))
        path.write_text(''.join(json.dumps(r)+'\n' for r in records))
    reference = records[0]; i = reference['row']; a = agent(device='cpu'); q = questions(a)
    with torch.inference_mode():
        batch = collate_items([preflight(a, rows[i]['text'], q)], a.tok.pad_token_id)
        missing = 4096-batch['input_ids'].shape[1]
        batch['input_ids'] = torch.nn.functional.pad(batch['input_ids'], (0, missing), value=a.tok.pad_token_id)
        batch['attention_mask'] = torch.nn.functional.pad(batch['attention_mask'], (0, missing))
        started = time.perf_counter(); z, _ = a._forward(batch)
        assert np.isfinite(z).all(); p = np.exp(z.astype(np.float64)-z.max(axis=1,keepdims=True)); p /= p.sum(axis=1,keepdims=True)
        difference = max(abs(float(p[0,1])-reference['normal']), abs(float(p[1,0])-reference['reversed']))
        assert difference < .003
    atomic_json(OUT / 'cpu-long-proof.json', {'passed': True, 'row': i, 'paddedTokens': 4096,
        'maximumGpuCpuScoreDelta': difference, 'secondsBothOrders': time.perf_counter()-started,
        'peakRssBytesMac': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        'qualityBenchmark': False, 'privateDataUploaded': False, 'paidCalls': 0})
    print('Bounded CPU 4k proof passed', flush=True)


def run(steps=None):
    OUT.mkdir(exist_ok=True, mode=0o700)
    try:
        for command in steps or ['prepare', '512', '1024', '2048', '4096', '8192', 'report', 'verify']:
            atomic_json(OUT / 'status.json', {'state': 'running', 'stage': command})
            with (OUT / f'{command}.log').open('a') as log:
                subprocess.run([sys.executable, __file__, command], stdout=log, stderr=subprocess.STDOUT, check=True)
        atomic_json(OUT / 'status.json', {'state': 'complete', 'fullBenchmarkCompleted': True,
            'verificationPassed': True, 'productionEnabled': False, 'paidCalls': 0})
    except BaseException as error:
        atomic_json(OUT / 'status.json', {'state': 'error', 'error': str(error)})
        raise
    finally:
        subprocess.run(['afplay', '/System/Library/Sounds/Glass.aiff'], check=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('command'); args = parser.parse_args()
    if args.command == 'run': run()
    elif args.command == 'finish': run(['8192', 'report', 'verify'])
    elif args.command == 'prepare': prepare()
    elif args.command == 'report': report()
    elif args.command == 'verify': verify()
    elif args.command == 'proof': proof()
    elif args.command == 'proof-long': proof_long()
    elif args.command == 'proof-8k': bucket(8192, maximum_rows=1, longest_first=True)
    else: bucket(int(args.command))
