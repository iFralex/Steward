"""Score the exact ORICO Gemma artifact, with no sampled/generated answers."""
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

os.environ.setdefault('PYTHONDONTWRITEBYTECODE', '1')
os.environ.setdefault('HF_HUB_OFFLINE', '1')
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local-evals/mail-detection-gemma'
MODEL = Path('/Volumes/ORICO/guarded-llm-models/gemma-4-E2B-it.litertlm')
CACHE = MODEL.parent / '.mail-detection-gemma-cache'
GEMMAPY = ROOT / '.local-evals/mail-detection-gemma-venv/bin/python'
BASEPY = ROOT / '.local-evals/mail-detection/venv/bin/python'
VARIANTS = ['noul-full', 'noul-binary']


def write(path, value):
    tmp = path.with_suffix('.tmp'); tmp.write_text(json.dumps(value, indent=2)); tmp.replace(path)


def context():
    plan = json.loads((OUT / 'plan.json').read_text()); source = Path(plan['datasetPath'])
    assert hashlib.sha256(source.read_bytes()).hexdigest() == plan['datasetSha256']
    assert hashlib.sha256((OUT / 'chat-template.jinja').read_bytes()).hexdigest() == plan['templateSha256']
    assert MODEL.stat().st_size == plan['model']['bytes']
    assert MODEL.stat().st_mtime_ns == plan['model']['mtimeNs']
    return plan, [json.loads(line) for line in source.open()]


def prepare():
    OUT.mkdir(exist_ok=True, mode=0o700)
    source = json.loads((ROOT / '.local-evals/mail-detection-openjev/plan.json').read_text())
    model = json.loads((OUT / 'model-provenance.json').read_text())
    assert model['sha256'] == '181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c'
    assert MODEL.stat().st_size == model['bytes'] == 2588147712
    model['mtimeNs'] = MODEL.stat().st_mtime_ns
    model.pop('hashSeconds', None)
    plan = {'datasetPath': source['datasetPath'], 'datasetSha256': source['datasetSha256'],
        'model': model, 'splits': source['splits'], 'gteOverflowRows': source['gteOverflowRows'],
        'policy': source['policy'], 'options': source['options'], 'variants': VARIANTS,
        'backend': 'LiteRT-LM GPU', 'runtimeVersion': '0.19.1', 'maxTotalTokens': 8192,
        'modelDefaultContext': 4096, 'modelDynamicContext': True,
        'templateSha256': hashlib.sha256((OUT / 'chat-template.jinja').read_bytes()).hexdigest(),
        'readout': 'same OpenJev full Noul prompt; independent yes/no continuation likelihoods',
        'scoring': 'one forced token per label, native run_text_scoring, no free generation',
        'cache': str(CACHE), 'policyCalibration': 'minimum positive in calibration; expanded bank secondary',
        'allFoldsPreviouslyInspected': True, 'productionEnabled': False, 'paidCalls': 0}
    path = OUT / 'plan.json'
    if path.exists(): assert json.loads(path.read_text()) == plan
    else: write(path, plan)


def runtime():
    from importlib.metadata import version
    import litert_lm as lm
    assert version('litert-lm-api') == '0.19.1'
    lm.set_min_log_severity(lm.LogSeverity.ERROR)
    CACHE.mkdir(exist_ok=True)
    return lm.Engine(str(MODEL), backend=lm.Backend.GPU(), max_num_tokens=8192,
        cache_dir=str(CACHE), use_ringbuffers_local_attention=False, enable_benchmark=True)


def prompt(plan, text):
    from jinja2.sandbox import ImmutableSandboxedEnvironment
    if not hasattr(prompt, 'template'):
        env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True,
            extensions=['jinja2.ext.do', 'jinja2.ext.loopcontrols'])
        env.globals['raise_exception'] = lambda message: (_ for _ in ()).throw(ValueError(message))
        prompt.template = env.from_string((OUT / 'chat-template.jinja').read_text())
    # Preserve exactly the OpenJev question/criterion serialization, changing
    # only the model-native chat template and the underlying model/runtime.
    if str(ROOT / '.local-models/openjev-runtime') not in sys.path:
        sys.path.insert(0, str(ROOT / '.local-models/openjev-runtime'))
    from openjev.prompt import dumps, system_instruction
    from openjev import ModelConfig
    user = ('State:\n' + dumps(text) + '\nQuestion:\n' + dumps({'instructions': plan['policy'],
        'false_when': plan['options']['A']}) + '\nCandidate:\n' +
        dumps({'answer': 'true', 'description': plan['options']['B']}) + '\nVerdict:\n')
    return prompt.template.render(messages=[{'role': 'system', 'content': system_instruction(ModelConfig())},
        {'role': 'user', 'content': user}], add_generation_prompt=True,
        bos_token='<bos>', eos_token='<eos>', enable_thinking=False, tools=[])


def score(engine, formatted, targets=('yes', 'no')):
    started = time.perf_counter(); count = len(engine.tokenize(formatted)); logp = []
    assert count + max(len(engine.tokenize(t)) for t in targets) <= 8192
    with engine.create_session(apply_prompt_template=False, max_output_tokens=1) as session:
        session.run_prefill([formatted]); info = session.get_benchmark_info()
        # The native prefill counter excludes one initial/pending token on this
        # bundle. It must still account for the complete supplied context.
        assert abs(info.last_prefill_token_count - count) <= 1
        for label in targets:
            with session.clone() as branch:
                response = branch.run_text_scoring([label], store_token_lengths=True)
                assert response.token_lengths == [1]
                assert len(response.token_scores) == 1 and len(response.token_scores[0]) == 1
                value = float(response.token_scores[0][0])
                assert math.isfinite(value) and value <= .0001
                assert abs(value-float(response.scores[0])) < 1e-5
                logp.append(value)
        assert session.get_benchmark_info().last_decode_token_count == 0
    high = max(logp); binary = math.exp(logp[0]-high)/(math.exp(logp[0]-high)+math.exp(logp[1]-high))
    return {'noul-full': math.exp(logp[0]), 'noul-binary': binary,
        'logProbYes': logp[0], 'logProbNo': logp[1], 'tokens': count,
        'nativePrefillTokens': info.last_prefill_token_count,
        'seconds': time.perf_counter()-started, 'generatedTokens': 0}


def preflight():
    import numpy as np
    plan, rows = context(); ids = sorted(set(i for n, values in plan['splits'].items() if n != 'optimization' for i in values))
    lengths = np.zeros(len(rows), dtype=np.int32); overflow = np.ones(len(rows), dtype=bool)
    gte_overflow = set(plan['gteOverflowRows'])
    with runtime() as engine:
        assert engine.detokenize([engine.bos_token_id]) == '<bos>'
        for i in ids:
            text = prompt(plan, rows[i]['text']); lengths[i] = len(engine.tokenize(text))
            overflow[i] = i in gte_overflow or lengths[i] + 2 > 8192
        np.save(OUT / 'lengths.npy', lengths); np.save(OUT / 'overflow.npy', overflow)
        longest = max((i for i in ids if not overflow[i]), key=lambda i: lengths[i])
        proof = score(engine, prompt(plan, rows[longest]['text']))
        assert proof['tokens'] > 4096 and proof['nativePrefillTokens'] > 4096
        write(OUT / 'native-8k-proof.json', {'row': longest, **proof, 'passed': True,
            'noTruncation': True, 'defaultContextOverridden': True})
    write(OUT / 'preflight.json', {'rows': len(ids), 'forcedForward': int(sum(overflow[i] for i in ids)),
        'templateFullyPreserved': True, 'noTruncation': True, 'native8kProofPassed': True})
    print('Full-context preflight and longest-thread scoring passed', flush=True)


def records(path):
    sys.path.insert(0, str(ROOT / 'tools/mail-detection'))
    import importlib.util
    spec = importlib.util.spec_from_file_location('qwen_bench', ROOT / 'tools/mail-detection/openjev-benchmark.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module.resume_records(path)


def bucket(limit):
    import numpy as np
    plan, rows = context(); lengths = np.load(OUT / 'lengths.npy'); overflow = np.load(OUT / 'overflow.npy')
    ids = sorted(set(i for n, values in plan['splits'].items() if n != 'optimization' for i in values))
    path = OUT / f'scores-{limit}.jsonl'; done = {r['row'] for r in records(path)}
    lower = 0 if limit == 1024 else limit//2
    pending = sorted([i for i in ids if i not in done and not overflow[i] and lower < lengths[i] <= limit], key=lambda i: lengths[i])
    if not pending: return
    with runtime() as engine, path.open('a') as output:
        for position, i in enumerate(pending):
            result = {'row': i, **score(engine, prompt(plan, rows[i]['text']))}
            output.write(json.dumps(result)+'\n'); output.flush()
            if position % 25 == 0: print(json.dumps({'bucket': limit, 'completed': position+1, 'pendingAtStart': len(pending)}), flush=True)


def verify():
    import numpy as np
    import resource
    plan, rows = context(); saved = {}
    for path in OUT.glob('scores-*.jsonl'):
        for r in records(path): assert r['row'] not in saved; saved[r['row']] = r
    lengths_gte = np.load(ROOT / '.local-evals/mail-detection-v2/gte/token-lengths.npy')
    selected = [max((i for i in saved if saved[i]['tokens'] <= b), key=lambda i:saved[i]['tokens']) for b in [1024,4096,8192]]
    checks = []; profiles = []
    with runtime() as engine:
        for i in selected:
            formatted = prompt(plan, rows[i]['text']); repeat = score(engine, formatted)
            delta = max(abs(repeat[n]-saved[i][n]) for n in VARIANTS)
            assert delta < .003
            reverse = score(engine, formatted, ('no','yes'))
            assert abs(reverse['logProbYes']-repeat['logProbNo']) < .003
            assert abs(reverse['logProbNo']-repeat['logProbYes']) < .003
            checks.append({'row': i, 'tokens': repeat['tokens'], 'maximumRepeatScoreDelta': delta,
                'targetOrderIndependenceVerified': True, 'nativePrefillTokens': repeat['nativePrefillTokens']})
            timings = [score(engine, formatted)['seconds'] for _ in range(3)]
            profiles.append({'row': i, 'totalPromptTokens': repeat['tokens'], 'gteBodyTokens': int(lengths_gte[i]),
                'question': 'noul', 'seconds': timings, 'p50': float(np.median(timings)),
                'processPeakRssBytesMac': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
    assert hashlib.file_digest(MODEL.open('rb'), 'sha256').hexdigest() == plan['model']['sha256']
    write(OUT / 'verification.json', {'passed': True, 'cachedScoresRepeated': checks,
        'modelFileUnchanged': True, 'noFreeGeneration': True, 'paidCalls': 0})
    write(OUT / 'single-question-profile.json', {'warm': True, 'backend': 'LiteRT-LM GPU', 'profiles': profiles})


def report():
    import numpy as np
    from run import metrics
    from followup import diagnostic_curve
    plan, rows = context(); y = np.asarray([r['label'] for r in rows]); splits = plan['splits']
    overflow = np.load(OUT / 'overflow.npy'); saved = {}
    for path in OUT.glob('scores-*.jsonl'):
        for r in records(path): assert r['row'] not in saved; saved[r['row']] = r
    ids = sorted(set(i for n, a in splits.items() if n != 'optimization' for i in a))
    assert all(overflow[i] or i in saved for i in ids)
    assert set(saved) == {i for i in ids if not overflow[i]}
    for r in saved.values():
        yes, no = math.exp(r['logProbYes']), math.exp(r['logProbNo'])
        assert yes + no <= 1.0001
        assert abs(yes-r['noul-full']) < 1e-12
        assert abs(yes/(yes+no)-r['noul-binary']) < 1e-12
        assert r['generatedTokens'] == 0 and abs(r['tokens']-r['nativePrefillTokens']) <= 1
    result = {'model': plan['model'], 'allFoldsExploratory': True, 'productionEnabled': False,
        'paidCalls': 0, 'coverage': {'rows': len(ids), 'inferred': len(saved), 'forcedForward':len(ids)-len(saved)}, 'variants':{}}
    lines = ['# Gemma 4 E2B da Orico', '', 'Studio retrospettivo sulle stesse etichette LLM: nessuna attivazione in produzione.', '',
        'File originale LiteRT-LM, GPU nativa, scoring yes/no senza generazione libera. Template esatto estratto dal file.', '',
        '| Variante | Banca | FN outer | FN test | Scarti test |', '|---|---|---:|---:|---:|']
    for name in VARIANTS:
        values = np.ones(len(rows))
        for i, r in saved.items(): values[i] = r[name]
        result['variants'][name] = {}
        for scope, bank in [('calibration',splits['calibration']),('expanded-bank-exploratory',splits['calibration']+splits['selection'])]:
            threshold = float(min(values[i] for i in bank if y[i]))
            folds = {n: metrics(y[a],values[a],threshold) for n,a in splits.items() if n != 'optimization'}
            result['variants'][name][scope] = {'threshold':threshold,'folds':folds}
            lines.append(f"| {name} | {scope} | {folds['outer_validation']['falseNegative']} | {folds['exploratory_test']['falseNegative']} | {folds['exploratory_test']['llmCallsAvoidedFraction']:.1%} |")
        result['variants'][name]['oracleRecallDiagnostics'] = {n:diagnostic_curve(y[a],values[a],[.99,1.]) for n,a in splits.items() if n != 'optimization'}
        np.save(OUT / f'{name}-scores.npy',values)
    write(OUT / 'evaluation.json',result)
    lines += ['', 'Il default del file è 4k dinamico; il contesto 8k effettivo è verificato nel runtime, senza tagli.',
        'Gli overflow sono inoltrati. Il target è promoteMail: gli allegati richiedono un percorso indipendente.',
        'La banca ampliata è secondaria e include selection. Tutti i fold sono già stati esaminati.']
    if (OUT / 'single-question-profile.json').exists():
        profile = json.loads((OUT / 'single-question-profile.json').read_text())
        lines += ['', '## Tempi sul Mac mini M4', '',
            'Mediana di tre richieste a caldo sulla GPU nativa, con gli altri servizi del Mac attivi.', '',
            '| Token prompt Gemma | Token testo GTE | Secondi |', '|---:|---:|---:|']
        for item in profile['profiles']:
            lines.append(f"| {item['totalPromptTokens']} | {item['gteBodyTokens']} | {item['p50']:.2f} |")
        lines += ['', 'I tokenizer differiscono: i profili degli altri modelli possono usare thread diversi.',
            'Il file originale pesa 2,59 GB e viene letto da Orico. Anche la cache GPU è su Orico.',
            'Il picco RSS nei profili non misura tutta la memoria GPU condivisa.',
            'Nessuna chiamata a pagamento. Controlli di ripetibilità e ordine yes/no superati; file originale invariato.']
    (OUT / 'comparison.md').write_text('\n'.join(lines)+'\n')


def run():
    OUT.mkdir(exist_ok=True,mode=0o700)
    with (OUT / 'runner.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: print('Existing Gemma runner active',flush=True); return
        (OUT / 'runner.pid').write_text(str(os.getpid())+'\n')
        try:
            prepare()
            for stage in ['preflight','1024','2048','4096','8192','verify','report']:
                if stage == 'preflight' and (OUT / 'preflight.json').exists(): continue
                write(OUT / 'status.json',{'state':'running','stage':stage,'pid':os.getpid()})
                python = BASEPY if stage == 'report' else GEMMAPY
                with (OUT / f'{stage}.log').open('a') as log:
                    subprocess.run([str(python),__file__,stage],stdout=log,stderr=subprocess.STDOUT,check=True)
            subprocess.run([str(BASEPY),str(ROOT/'tools/mail-detection/report-decision-models.py')],check=True)
            write(OUT/'status.json',{'state':'complete','verified':True,'productionEnabled':False,'paidCalls':0})
        except BaseException as error:
            write(OUT/'status.json',{'state':'error','error':str(error)}); raise
        finally: subprocess.run(['afplay','/System/Library/Sounds/Glass.aiff'],check=False)


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('command');args=parser.parse_args()
    if args.command=='prepare':prepare()
    elif args.command=='preflight':preflight()
    elif args.command=='verify':verify()
    elif args.command=='report':report()
    elif args.command=='run':run()
    else:bucket(int(args.command))
