"""Compare all completed local decision families on identical coverage."""
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import direct as d
from run import atomic_json, metrics
from followup import diagnostic_curve

OUT = d.ROOT / '.local-evals/mail-detection-decisions'


def main():
    OUT.mkdir(exist_ok=True, mode=0o700)
    rows, digest, _, splits, lengths = d.context()
    y = np.asarray([r['label'] for r in rows])
    has_attachments = np.asarray([bool(r['attachments']) for r in rows])
    families = {name: d.ROOT / f'.local-evals/mail-detection-{name}' for name in ['laya', 'openjev']}
    gemma = d.ROOT / '.local-evals/mail-detection-gemma'
    if (gemma / 'verification.json').exists() and json.loads((gemma / 'verification.json').read_text()).get('passed') and (gemma / 'evaluation.json').exists():
        families['gemma'] = gemma
    overflow = lengths > 8192
    scores = {}; group = {}
    for name in ['base-meta', 'tuned-head']:
        scores['gte/' + name] = np.load(d.ROOT / '.local-evals/mail-detection-followup' / f'{name}-scores.npy').copy()
        group['gte/' + name] = 'GTE'
    for name, folder in families.items():
        plan = json.loads((folder / 'plan.json').read_text()); assert plan['datasetSha256'] == digest
        assert json.loads((folder / 'verification.json').read_text())['passed']
        overflow |= np.load(folder / 'overflow.npy')
        for variant in plan['variants']:
            key = name + '/' + variant
            scores[key] = np.load(folder / f'{variant}-scores.npy').copy()
            group[key] = name.capitalize()
    for value in scores.values(): value[overflow] = 1.
    final = splits['outer_validation'] + splits['exploratory_test']
    all_eval = splits['calibration'] + splits['selection'] + final
    result = {'datasetSha256': digest, 'allFoldsPreviouslyInspected': True,
        'labels': 'historical LLM decisions, not human ground truth', 'productionEnabled': False,
        'coverage': {'evaluatedRows': len(all_eval), 'forcedForwardRows': int(overflow[all_eval].sum()),
                     'finalRows': len(final), 'finalPositives': int(y[final].sum())},
        'variants': {}}
    lines = ['# Confronto dei paradigmi decisionali locali', '',
        '**Studio retrospettivo esplorativo. Etichette storiche LLM; nessuna attivazione in produzione.**', '',
        'Stessi thread completi e stessa copertura: se almeno un candidato supera il proprio budget, tutti inoltrano quel caso.',
        'Le percentuali simulano il routing su questo campione filtrato: non sono risparmi monetari misurati sul flusso reale.',
        'La soglia di ogni score è il minimo dei positivi nella banca indicata; nessun addestramento o scelta della soglia usa i vecchi fold finali.',
        'I fold finali erano già stati esaminati in esperimenti precedenti, quindi non sono un nuovo test indipendente.', '']
    scopes = [('calibration', splits['calibration']),
              ('expanded-bank-exploratory', splits['calibration'] + splits['selection'])]
    for scope, bank in scopes:
        lines += [f'## {scope}: {int(y[bank].sum())} positivi', '',
            '| Modello/readout | FN mail | Scarti mail | FN inoltrando gli allegati | Scarti inoltrando gli allegati |',
            '|---|---:|---:|---:|---:|']
        for name, value in scores.items():
            threshold = float(min(value[i] for i in bank if y[i]))
            measured = metrics(y[final], value[final], threshold)
            guarded = value.copy(); guarded[has_attachments] = 1.
            guarded_metrics = metrics(y[final], guarded[final], threshold)
            assert guarded_metrics['falseNegative'] <= measured['falseNegative']
            result['variants'].setdefault(name, {})[scope] = {'threshold': threshold, 'combinedFinal': measured,
                'attachmentForwardingCounterfactual': {'combinedFinal': guarded_metrics,
                    'thresholdUnchanged': True, 'postHocDiagnostic': True,
                    'rule': 'always forward every thread with at least one attachment'},
                'folds': {n: metrics(y[a], value[a], threshold) for n, a in splits.items() if n != 'optimization'}}
            lines.append(f"| {name} | {measured['falseNegative']}/{int(y[final].sum())} | {measured['llmCallsAvoidedFraction']:.1%} | {guarded_metrics['falseNegative']}/{int(y[final].sum())} | {guarded_metrics['llmCallsAvoidedFraction']:.1%} |")
        lines.append('')
    for name, value in scores.items():
        result['variants'][name]['oracleRecallDiagnostics'] = diagnostic_curve(y[final], value[final], [.99, 1.])
    profiles = {}
    for name, folder in families.items():
        profiles[name] = json.loads((folder / 'single-question-profile.json').read_text())
    result['singleQuestionProfiles'] = profiles
    # Separate, blind supplement: do not overwrite the existing review packet.
    # These are targeted disagreements, not an independent evaluation sample.
    thresholds = {n: result['variants'][n]['expanded-bank-exploratory']['threshold'] for n in scores}
    disagreements = [i for i in final if len({bool(v[i] >= thresholds[n]) for n, v in scores.items()}) > 1]
    positive = [i for i in disagreements if y[i]]; negative = [i for i in disagreements if not y[i]]
    selected = list(dict.fromkeys(positive[:10] + negative[:10] + disagreements))[:20]
    review = OUT / 'decision-disagreements-blind.jsonl'
    annotated = review.exists() and any(json.loads(line).get('humanLabel') is not None or
        bool(json.loads(line).get('humanReason')) for line in review.open())
    if not annotated:
        with review.open('w') as output, (OUT / 'decision-disagreements-debug.jsonl').open('w') as debug:
            for i in selected:
                output.write(json.dumps({'row': i, 'text': rows[i]['text'], 'humanLabel': None, 'humanReason': None}, ensure_ascii=False)+'\n')
                debug.write(json.dumps({'row': i, 'historicalWeakLabel': int(y[i]),
                    'keepByModel': {n: bool(v[i] >= thresholds[n]) for n, v in scores.items()}}, ensure_ascii=False)+'\n')
    result['reviewSupplement'] = {'path': str(review), 'preservedHumanAnnotations': annotated,
        'targetedDisagreements': True, 'independentTest': False}
    lines += ['![Confronto esplorativo con calibrazione ampliata](comparison.png)', '',
        '## Limiti e lettura dei risultati', '',
        '- La banca ampliata comprende selection: è un’analisi secondaria, non una nuova validazione.',
        '- Zero falsi negativi osservati non garantisce recall 100% su nuove mail o rispetto a etichette umane.',
        '- Le sei varianti OpenJev sono readout di un unico Qwen3.5-0.8B quantizzato a 4 bit, non sei modelli addestrati.',
        '- La media delle etichette A/B è una variante fissata in anticipo; non è un’implementazione di AnyJev.',
        '- Le probabilità dei decision model non sono automaticamente calibrate sulla policy.',
        '- Il target è promoteMail. Gli allegati richiedono una decisione indipendente: non usare questi scarti per saltare l’intero triage.',
        '- Le colonne sugli allegati simulano una regola prudente aggiunta a posteriori: inoltrare sempre i thread con file, mantenendo identica la soglia. Non costituiscono una nuova validazione.',
        '- I negativi storici con allegati e snapshot non verificabili erano esclusi dal dataset: il campione non rappresenta automaticamente tutte le mail o tutte le chiamate fatturate.',
        '- Gli scarti contano i thread del campione: non pesano costo per token, numero di riesami o tariffe delle chiamate effettivamente fatturate.',
        '- Rizzo Flow e gli altri framework restano nella ricerca: non risultano benchmarkati sulle mail da questi script.', '',
        'I profili per una sola domanda sono salvati in comparison.json; i tempi dei benchmark completi includono più readout per thread.', '',
        'I profili usano campioni vicini alle finestre native dei rispettivi tokenizer, non sempre lo stesso thread. Sono misure indicative sul Mac con gli altri servizi attivi; distinguere il totale del prompt dai token del testo.', '',
        'È disponibile un supplemento cieco di massimo 20 disaccordi in `decision-disagreements-blind.jsonl`. Usare Today del thread storico e valutare promoteMail separatamente dagli allegati. Il file debug separato contiene i segnali dei modelli e le etichette deboli.', '',
        '[Dettagli Laya](../mail-detection-laya/comparison.md) · [Dettagli OpenJev](../mail-detection-openjev/comparison.md) · [Ricerca](../mail-detection-followup/decision-models.md)', '']
    if 'gemma' in families:
        lines += ['[Dettagli Gemma 4 E2B da Orico](../mail-detection-gemma/comparison.md). '
                  'I due score Gemma usano un solo prefill e le probabilità native delle continuazioni yes/no, '
                  'con lo stesso prompt Noul di OpenJev, senza generazione libera. '
                  'Il contesto effettivo oltre 4k è verificato nel runtime LiteRT-LM GPU.', '']
    atomic_json(OUT / 'comparison.json', result)
    (OUT / 'comparison.md').write_text('\n'.join(lines))
    banner = '> Ultimo confronto locale: [confronto dei modelli decisionali](../mail-detection-decisions/comparison.md).\n\n'
    for directory in ['mail-detection', 'mail-detection-v2', 'mail-detection-direct',
                      'mail-detection-followup', 'mail-detection-laya', 'mail-detection-openjev', 'mail-detection-gemma']:
        path = d.ROOT / '.local-evals' / directory / 'comparison.md'
        if path.exists() and not path.read_text().startswith(banner):
            body = path.read_text()
            if body.startswith('> Ultimo confronto locale: '):
                body = body.split('\n\n', 1)[1]
            path.write_text(banner + body)
    os.environ.setdefault('MPLCONFIGDIR', str(OUT / 'matplotlib'))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    names = list(scores)
    measures = [result['variants'][n]['expanded-bank-exploratory']['combinedFinal'] for n in names]
    fig, ax = plt.subplots(figsize=(11, 7))
    colors = {'GTE': '#3366aa', 'Laya': '#c07922', 'Openjev': '#34875d', 'Gemma': '#8856a7'}
    ax.barh(names, [100*m['llmCallsAvoidedFraction'] for m in measures], color=[colors[group[n]] for n in names])
    for j, m in enumerate(measures):
        ax.text(100*m['llmCallsAvoidedFraction']+.7, j,
                f"{m['falseNegative']}/{int(y[final].sum())} FN", va='center', fontsize=9)
    ax.invert_yaxis(); ax.set_xlim(0, 100); ax.set_xlabel('Chiamate LLM evitabili (%)')
    ax.set_title('Etichette storiche: banca ampliata, confronto esplorativo')
    ax.grid(axis='x', alpha=.2); ax.set_axisbelow(True); fig.tight_layout()
    fig.savefig(OUT / 'comparison.svg'); fig.savefig(OUT / 'comparison.png', dpi=150); plt.close(fig)
    review_rows = [json.loads(line) for line in review.open()]
    assert len(review_rows) == len({r['row'] for r in review_rows})
    assert all(r['text'] == rows[r['row']]['text'] for r in review_rows)
    assert all(set(r) == {'row', 'text', 'humanLabel', 'humanReason'} for r in review_rows)
    assert all(len(value) == len(rows) and np.isfinite(value).all() and
               (value >= 0).all() and (value <= 1).all() for value in scores.values())
    gte = d.ROOT / '.local-models/hub/models--Alibaba-NLP--gte-multilingual-base/snapshots/9bbca17d9273fd0d03d5725c7a4b0f6b45142062/model.safetensors'
    with gte.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == 'f5a35a10faa54da7717870af1517c9b41e9bd8e3880bc5a8e9363d4c3c63e9b0'
    atomic_json(OUT / 'final-verification.json', {'passed': True, 'variants': len(scores),
        'blindReviewCases': len(review_rows), 'sourceTextsMatched': True,
        'gteCacheRestoredHashVerified': True, 'nativeScoresFiniteInRange': True,
        'completedFamilies': list(families), 'productionEnabled': False, 'paidCalls': 0})
    print(str(OUT / 'comparison.md'))


if __name__ == '__main__': main()
