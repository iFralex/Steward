"""Publish the final independent-test comparison after validation-only choices."""
import json
from pathlib import Path

from run import ROOT, atomic_json, load_dataset


def collect(directory):
    rows, digest = load_dataset(directory)
    summary = json.loads((directory / 'dataset-summary.json').read_text())
    decision = json.loads((directory / 'metadata-decision.json').read_text())
    assert decision['testUsedForThisDecision'] is False
    names = ['gte', 'bge', 'gte-setfit']
    if decision['metadataRequired']:
        names += ['gte-meta', 'bge-meta', 'gte-setfit-meta']
    reports = {}
    for name in names:
        report = json.loads((directory / name / 'report.json').read_text())
        if report['datasetSha256'] != digest:
            raise RuntimeError(f'{name}: mismatched dataset')
        reports[name] = report
    profiles = {}
    for name in ['gte', 'bge', 'gte-setfit']:
        profile = json.loads((directory / name / 'profile.json').read_text())
        if profile['datasetSha256'] != digest or profile['encoder'] != reports[name]['encoder']:
            raise RuntimeError(f'{name}: mismatched profile')
        profiles[name] = profile
    training = json.loads((directory / 'setfit-training.json').read_text())
    assert training['datasetSha256'] == digest
    assert training['outputWeightsSha256'] == reports['gte-setfit']['encoder']['fineTunedWeightsSha256']
    pairs = json.loads((directory / 'setfit-pairs.json').read_text())
    assert all(rows[p[k]]['split'] == 'train' for p in pairs for k in ['leftRow', 'rightRow'])
    assert all((rows[p['leftRow']]['label'] == rows[p['rightRow']]['label']) == p['sameLabel'] for p in pairs)
    # Choose with validation only; ties favor the simpler earlier-listed model.
    selected = max(names, key=lambda name: reports[name]['conservativeValidationPolicy']['validation']['llmCallsAvoidedFraction'])
    selection = json.loads((directory / 'selection.json').read_text())
    assert selection['testUsedForSelection'] is False and selection['selectedOnValidation'] == selected
    result = {'status': 'experiment_complete', 'datasetSha256': digest, 'productionEnabled': False,
              'datasetPolicy': summary, 'setfitTraining': training,
              'metadataDecision': decision, 'selectedOnValidation': selected,
              'selectionBeforeTestReview': selection,
              'models': reports, 'profiles': profiles,
              'verification': {'trainingPairsUseTrainingOnly': True, 'pairLabelsConsistent': True}}
    atomic_json(directory / 'comparison.json', result)
    lines = ['# Secondo esperimento di mail detection', '',
             '**Confronto offline completato. Nessun filtro attivo in produzione.**', '',
             'Le etichette sono decisioni LLM verificate o inferite da audit e stato terminale; non sono ground truth umana.', '',
             '| Split | Negativi | Positivi |', '|---|---:|---:|']
    for split, data in summary['splits'].items():
        counts = data['selected']
        lines.append(f"| {split} | {counts.get('0', 0)} | {counts.get('1', 0)} |")
    lines.extend(['', 'Validazione e test hanno gruppi di template assenti da tutto il primo esperimento e coprono più periodi delle mail e più giornate di decisione.', '',
                  '**I tassi di scarto sotto sono diagnostici:** il campione sovrarappresenta positivi e periodi rari; non stimano il risparmio in produzione.', '',
                  '| Modello, soglia prudente | Scarto validazione | Positivi persi nel test | Negativi scartati nel test | Scarto totale test |',
                  '|---|---:|---:|---:|---:|'])
    for name, report in reports.items():
        policy = report['conservativeValidationPolicy']
        v, t = policy['validation'], policy['test']
        lines.append(f"| {name} | {v['llmCallsAvoidedFraction']:.1%} | {t['falseNegative']}/{t['positiveExamples']} | {t['trueNegative']}/{t['examples']-t['positiveExamples']} | {t['llmCallsAvoidedFraction']:.1%} |")
    lines.extend(['', f'La scelta sulla sola validazione è **{selected}**. Il test non è stato usato per scegliere regolarizzazione, soglie o l’avvio della prova con metadati.', '',
                  'Il criterio fissato prima del confronto richiedeva a SetFit almeno tre punti percentuali di scarto in più rispetto alla migliore baseline, senza perdere positivi di validazione. Metadati richiesti dalla validazione: **' + ('sì' if decision['metadataRequired'] else 'no') + '**.', '',
                  f"SetFit: {training['steps']} passi su {training['trainingDevice']}, {training['trainingExamples']} esempi selezionati, {training.get('pairedTrainingExamples', '?')} effettivamente presenti nelle coppie; ultimi {training['trainLastLayers']} strati aggiornati, contesto 8.192 token. Tempo di training/esportazione: {training['seconds']:.1f} secondi.", '',
                  'Le coppie difficili provengono esclusivamente dal training. L’esportazione parziale riutilizza la base GTE fissata e non duplica l’intero modello.', '',
                  '| Encoder | ~512 token | ~4k token | ~8k token |', '|---|---:|---:|---:|'])
    for name, profile in profiles.items():
        samples = {s['requestedTokens']: s for s in profile['singleRequestWarmLatency']}
        cells = [f"{samples[n]['medianSeconds']:.3f} s" for n in [512, 4096, 8192]]
        lines.append('| ' + ' | '.join([name, *cells]) + ' |')
    lines.extend(['', 'Tempi mediani dell’encoder già caricato, su thread reali e con altri servizi del Mac attivi. Le varianti con metadati riutilizzano lo stesso encoder.', '',
                  'Ogni campione resta sotto la soglia indicata, per evitare che il padding arrotondi un thread appena sopra 4.096 token fino a 8.192. I conteggi effettivi sono nei file profile.json.', '',
                  '## Policy alternativa: target 99% sulla validazione', '',
                  'Questa policy era prevista prima del test e consente un errore fra i positivi di validazione. Non garantisce recall del 99% in produzione.', '',
                  '| Modello | Positivi persi nel test | Scarto totale test |', '|---|---:|---:|'])
    for name, report in reports.items():
        t = report['test']
        lines.append(f"| {name} | {t['falseNegative']}/{t['positiveExamples']} | {t['llmCallsAvoidedFraction']:.1%} |")
    lines.extend(['',
                  '## Qualità delle etichette e limiti', '',
                  '- Positivi storici senza evidenza sufficiente e negativi con allegati non verificabili sono esclusi. La copertura degli allegati resta quindi parziale.',
                  '- I vecchi verdetti erano prodotti con un input troncato per caratteri; il detector vede il testo completo fino a 8k.',
                  '- Gli input oltre 8k sono inoltrati all’LLM nella simulazione, mai troncati o scartati automaticamente.',
                  '- Il campione è retrospettivo; non è un test su mail future. Anche zero errori su questo test non dimostra recall del 99% in produzione.',
                  '- Il controllo qualitativo in [qualitative-review.json](qualitative-review.json) è assistito da Codex, non una revisione umana. Non modifica le etichette del test.',
                  '- La registrazione esplicita dei nuovi verdetti è implementata e verificata con test e controllo tipi, ma il servizio in esecuzione non è stato aggiornato.', '',
                  'Dettagli completi, inclusi intervalli di confidenza e policy al 99% sulla validazione, in [comparison.json](comparison.json).', ''])
    (directory / 'comparison.md').write_text('\n'.join(lines))
    old_report = ROOT / '.local-evals/mail-detection/comparison.md'
    if old_report.exists():
        old = old_report.read_text()
        if old.startswith('> È in corso'):
            old_report.write_text('> È disponibile il [secondo esperimento completato](../mail-detection-v2/comparison.md). I risultati sotto restano quelli del primo pilot.\n\n' + old.split('\n\n', 1)[1])
    print('\n'.join(lines))
    return result


if __name__ == '__main__':
    collect(ROOT / '.local-evals/mail-detection-v2')
