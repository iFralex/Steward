"""Report directly supervised checkpoints without calling an old test pristine."""
import json
from pathlib import Path

from run import ROOT, atomic_json


def collect():
    folder=ROOT/'.local-evals/mail-detection-direct'
    plan=json.loads((folder/'plan.json').read_text())
    prepared=json.loads((folder/'prepared.json').read_text())
    choice=json.loads((folder/'selection.json').read_text())
    evaluation=json.loads((folder/'evaluation.json').read_text())
    assert choice['testUsedForSelection'] is False and choice['selectedBeforeFinalEvaluation'] is True
    assert evaluation['testUsedForCheckpointOrDepthSelection'] is False
    assert evaluation['selected']==choice['selectedOnValidation']
    selected=choice['selectedOnValidation']
    result={'status':'experiment_complete','plan':plan,'splitCounts':prepared['splitCounts'],
            'selection':choice,'evaluation':evaluation,'productionEnabled':False}
    verification=folder/'verification.json'
    if verification.exists():result['verification']=json.loads(verification.read_text())
    profile=folder/'profile.json'
    if profile.exists():result['selectedProfile']=json.loads(profile.read_text())
    histories={}
    for depth in plan['depths']:
        path=folder/f'direct-l{depth}/history.json'
        if path.exists():histories[str(depth)]=json.loads(path.read_text())
    result['checkpointHistories']=histories
    conclusion=''
    if selected.startswith('direct-frozen') and '12' in histories:
        initial=histories['12'][0]['selection']
        peak=max((p for p in histories['12'] if p['examplesSeen']>0),key=lambda p:p['selection']['rocAuc'])
        m=peak['selection'];baseline=choice['candidates'][selected]['selection']
        conclusion=(f"Il fine-tuning ha un effetto misurabile: con dodici strati l’AUC sale da {initial['rocAuc']:.3f} a {m['rocAuc']:.3f} al checkpoint di {peak['examplesSeen']} documenti. "
                    f"Alla soglia calibrata, però, quel checkpoint perde {m['falseNegative']}/{m['positiveExamples']} positivi, contro {baseline['falseNegative']}/{baseline['positiveExamples']} del controllo congelato con metadati. "
                    "Queste prove non giustificano quindi la sostituzione del controllo conservativo con l’encoder fine-tuned. L’aumento dell’AUC globale non garantisce un miglioramento nel punto di lavoro ad alto recall.")
        result['interpretation']=conclusion
    atomic_json(folder/'comparison.json',result)
    lines=['# Fine-tuning supervisionato diretto', '',
           '**Studio completato; nessuna attivazione in produzione.**', '',
           f'Scelta effettuata sui nuovi sottoinsiemi di validazione: **{selected}**.', '',
           conclusion, '',
           'La loss è BCE sulla decisione conserva/scarta. Ogni profondità parte dallo stesso GTE multilingue base e dalla stessa testa iniziale, senza ereditare i pesi SetFit. Il vocabolario resta congelato; gli strati contestuali e la testa vengono aggiornati insieme.', '',
           'Per contenere memoria e swap dopo un arresto della prova a sei strati, le prove profonde usano Adafactor e valutazione CPU con un documento alla volta. La prova a due strati usa AdamW. Il confronto varia quindi profondità e ottimizzatore: non è un’ablation pura della sola profondità.', '',
           'Nella ripartenza a dodici strati, la tabella del vocabolario congelata resta nel formato FP16 originale; si convertono in FP32 soltanto le righe richieste. Tutti i valori sono verificati per round-trip esatto, mentre strati addestrabili e maschere restano FP32. Il risparmio è di 384 MB e non introduce ulteriore quantizzazione.', '',
           f"Riserva disco finale: {plan.get('diskReserveMiB',1024)} MiB, più lo spazio previsto per il checkpoint. Due tentativi a sei strati si sono fermati alla precedente riserva di 1 GiB, prima con AdamW e poi durante la valutazione CPU con Adafactor; nessun errore di disco pieno. Le prove interrotte non entrano nei risultati, e la ripartenza usa nuovamente il modello base.", '',
           '| Sottoinsieme | Thread | Positivi | Uso |', '|---|---:|---:|---|']
    descriptions={'optimization':'inizializzazione della testa e loss', 'calibration':'soglia, nessuna loss',
                  'selection':'checkpoint, arresto e profondità, nessuna loss',
                  'outer_validation':'confronto esplorativo finale già utilizzato negli studi precedenti',
                  'exploratory_test':'test esplorativo già esaminato in precedenza'}
    for name,counts in prepared['splitCounts'].items():
        lines.append(f"| {name} | {counts['total']} | {counts['positive']} | {descriptions[name]} |")
    lines.extend(['', '**Il vecchio test non è più un test indipendente mai visto.** Non determina checkpoint o profondità in questo studio, ma i suoi risultati finali restano esplorativi. Per confermare la generalizzazione serviranno nuove mail o etichette indipendenti.', '',
                  f"Training previsto: {plan['examples']} documenti distinti, accumulo su quattro documenti, checkpoint a {plan['checkpointsAtExamples']}. Tutti i documenti della loss provengono da optimization; i casi qualitativi già esaminati sono esclusi dai nuovi holdout.", '',
                  '| Candidato | Miglior checkpoint CPU, documenti | Positivi persi selection | Negativi scartati selection | Scarti selection |', '|---|---:|---:|---:|---:|'])
    for name,candidate in choice['candidates'].items():
        measured=candidate['selection']
        checkpoint=candidate.get('checkpoint',{}).get('examplesSeen','—')
        lines.append(f"| {name} | {checkpoint} | {measured['falseNegative']}/{measured['positiveExamples']} | {measured['trueNegative']}/{measured['examples']-measured['positiveExamples']} | {measured['llmCallsAvoidedFraction']:.1%} |")
    lines.extend(['', 'Il checkpoint 0 contiene encoder e testa iniziali, prima degli aggiornamenti. Se viene preferito, il training è stato eseguito ma i checkpoint successivi non hanno migliorato il criterio conservativo. Le curve riportano anche i risultati dei checkpoint scartati.', '',
                  'La soglia conserva tutti i positivi di calibration. I checkpoint CPU sono scelti prima per numero di positivi persi in selection, poi per negativi scartati e infine per log-loss. Dopo l’esportazione FP16, ogni miglior checkpoint è ricalibrato e verificato usando embedding GPU prima della scelta della profondità. Per checkpoint vuoti, identici al base, si può riusare la cache GPU verificata; per pesi aggiornati si esegue nuova inferenza.', '',
                  'Il passaggio alla profondità successiva dipende soltanto da selection. Sono richiesti almeno il 99% di recall e un miglioramento del trade-off rispetto alla migliore baseline congelata riaddestrata sugli stessi dati. Un checkpoint senza aggiornamenti non è considerato successo del fine-tuning.', '',
                  '## Curve dei checkpoint CPU', ''])
    for depth,history in histories.items():
        done=json.loads((folder/f'direct-l{depth}/done.json').read_text())
        lines.extend([f"### Ultimi {depth} strati", '',
                      f"Parametri encoder aggiornabili: {done['encoderTrainableParameters']:,}; testa: 769. Ottimizzatore: {done['optimizer']}. Documenti usati nella loss: {done['uniqueLossExamples']}. Tempo del loop, incluse le valutazioni CPU intermedie: {done['seconds']:.1f} secondi. Arresto anticipato: {done['earlyStopped']}.", '',
                      '| Documenti elaborati | Positivi persi selection | Negativi scartati selection | AUC selection | Log-loss selection |', '|---|---:|---:|---:|---:|'])
        for checkpoint in history:
            m=checkpoint['selection']
            lines.append(f"| {checkpoint['examplesSeen']} | {m['falseNegative']}/{m['positiveExamples']} | {m['trueNegative']} | {m['rocAuc']:.4f} | {checkpoint['selectionLogLoss']:.4f} |")
        lines.append('')
    lines.extend(['## Confronto finale esplorativo', '',
                  'Queste baseline sono riaddestrate sugli stessi soli dati optimization. La scelta del modello è già fissata prima di calcolare questa tabella.', '',
                  '| Modello | Positivi persi nella vecchia validazione | Positivi persi nel vecchio test | Negativi scartati nel vecchio test | Scarto totale nel vecchio test |', '|---|---:|---:|---:|---:|'])
    final={**evaluation['refittedFrozenControls'],selected:evaluation['selectedEvaluation']}
    for name,values in final.items():
        m=values['exploratory_test'];outer=values['outer_validation']
        lines.append(f"| {name} | {outer['falseNegative']}/{outer['positiveExamples']} | {m['falseNegative']}/{m['positiveExamples']} | {m['trueNegative']}/{m['examples']-m['positiveExamples']} | {m['llmCallsAvoidedFraction']:.1%} |")
    outer=evaluation['selectedEvaluation']['outer_validation']
    lines.extend(['', f"Il candidato selezionato perde {outer['falseNegative']}/{outer['positiveExamples']} positivi nella vecchia validazione (recall {outer['recallKeep']:.1%}). Lo zero eventualmente osservato nel vecchio test non dimostra quindi una conservazione uniforme dei positivi. Questi risultati finali non sono usati per riaggiustare soglie o riselezionare il modello; non viene attivato un filtro in produzione.", '',
                  'Il precedente GTE + metadati dello [studio v2](../mail-detection-v2/comparison.md) aveva 0/108 positivi persi e 435/752 negativi scartati, ma disponeva di più etichette per la testa: tutti i 2.806 vecchi esempi di training, inclusi i nuovi calibration/selection. Non è quindi un controllo con lo stesso budget di dati.', '',
                  'I tassi di scarto restano diagnostici, non una stima del risparmio monetario. Le etichette rimangono verdetti LLM verificati o inferiti dall’audit; i thread oltre 8.192 token sono inoltrati nella simulazione, mai tagliati o scartati automaticamente.', ''])
    if 'selectedProfile' in result:
        lines.extend(['## Tempi del detector selezionato', '', '| Token effettivi | Mediana, modello già caricato |', '|---:|---:|'])
        for sample in result['selectedProfile']['samples']:
            lines.append(f"| {sample['actualTokens']} | {sample['medianSeconds']:.4f} s |")
        lines.append('')
    lines.extend(['Dettagli e verifiche in [comparison.json](comparison.json).', ''])
    (folder/'comparison.md').write_text('\n'.join(lines))
    for previous in [ROOT/'.local-evals/mail-detection/comparison.md',ROOT/'.local-evals/mail-detection-v2/comparison.md']:
        text=previous.read_text()
        note='> È disponibile il [nuovo studio supervisionato diretto](../mail-detection-direct/comparison.md).\n\n'
        if not text.startswith(note):previous.write_text(note+text)
    print('\n'.join(lines))


if __name__=='__main__':collect()
