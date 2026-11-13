"""Report calibrated decisions separately from oracle high-recall curves."""
import json
import os
from pathlib import Path

import numpy as np

from followup import OUT,setup
from run import atomic_json


def main():
    rows,digest,plan,splits,lengths=setup()
    selection=json.loads((OUT/'selection.json').read_text());evaluation=json.loads((OUT/'evaluation.json').read_text())
    verification=json.loads((OUT/'verification.json').read_text())
    assert not selection['finalFoldsUsed'] and evaluation['selectionFixedBeforeFinalEvaluation']
    result={'selection':selection,'evaluation':evaluation,'verification':verification,'productionEnabled':False}
    expanded_path=OUT/'expanded-calibration-backtest.json'
    if expanded_path.exists():result['expandedCalibrationExploratory']=json.loads(expanded_path.read_text())
    expanded_preview=OUT/'expanded-preview-verification.json'
    if expanded_preview.exists():result['expandedPreviewVerification']=json.loads(expanded_preview.read_text())
    result['tunedHeadProfiles']=[json.loads(path.read_text()) for path in sorted(OUT.glob('profile-tuned-head-*.json'))]
    atomic_json(OUT/'comparison.json',result)
    lines=['# Encoder, testa rifittata e metadati','',f"Selezione principale, con calibrazione iniziale: **{selection['selected']}**. Nessuna attivazione in produzione.",'',
        'Il checkpoint a dodici strati dopo 256 documenti è stato riprodotto dalla stessa inizializzazione, con identico ordine dei dati e identico learning-rate schedule da 1.024 documenti. Tutti i 16 controlli di loss e norma del gradiente coincidono con il run originale. Il checkpoint è ora conservato, anziché scartato dalla selezione conservativa.','',
        'Le nuove teste logistiche sono addestrate sui soli dati optimization. Regolarizzazione e peso dei metadati si scelgono solo su calibration. La scelta fra candidati usa selection prima dei risultati finali. Tutti questi fold sono già stati esaminati nei precedenti studi: i risultati rimangono esplorativi. I positivi sono verdetti storici del teacher/audit, ancora etichette deboli, non giudizi umani.','',
        '| Candidato | Positivi persi selection | Negativi scartati selection | AUC selection | Positivi persi vecchia validazione | Positivi persi vecchio test | Scarti vecchio test |',
        '|---|---:|---:|---:|---:|---:|---:|']
    for name,c in selection['candidates'].items():
        m=c['selection'];v=evaluation['final'][name]['outer_validation'];t=evaluation['final'][name]['exploratory_test']
        lines.append(f"| {name} | {m['falseNegative']}/{m['positiveExamples']} | {m['trueNegative']} | {m['rocAuc']:.4f} | {v['falseNegative']}/{v['positiveExamples']} | {t['falseNegative']}/{t['positiveExamples']} | {t['llmCallsAvoidedFraction']:.1%} |")
    weights=', '.join(f"{name}={c['metadataWeight']:g}" for name,c in selection['candidates'].items() if 'metadataWeight' in c)
    lines.extend(['',f'Pesi dei metadati scelti su calibration: {weights}. Un peso zero equivale a escluderne il contributo.'])
    lines.extend(['','`base` riusa GTE congelato. `tuned` usa il checkpoint aggiornato. `head` è la nuova testa senza metadati; `meta` include gli stessi metadati osservabili della baseline. `tuned-joint-head` conserva la testa aggiornata insieme all’encoder. `sparse-text-meta` usa parole e bigrammi TF-IDF, senza encoder. `consensus` scarta solo quando sia `base-meta` sia `sparse-text-meta` scartano: regola fissata prima dei risultati. Il suo score è un margine trasformato, non una probabilità calibrata.','',
        '## Confronto a parità di recall osservato','',
        '**Le soglie di questa tabella sono oracle diagnostiche sul fold mostrato. Non sono soglie da applicare a nuove mail.** Servono a confrontare l’ordinamento dei modelli nella regione ad alto recall, separandolo dalla stabilità della calibrazione.','',
        '| Candidato | Selection: scarti a recall ≥99% | Selection: scarti a recall 100% | Vecchia validazione: scarti a recall 100% | Vecchio test: scarti a recall 100% |',
        '|---|---:|---:|---:|---:|'])
    curves=evaluation['matchedRecallOracleDiagnostics']
    for name,parts in curves.items():
        values=[parts['selection'][0],parts['selection'][1],parts['outer_validation'][1],parts['exploratory_test'][1]]
        lines.append('| '+name+' | '+' | '.join(f"{v['metrics']['llmCallsAvoidedFraction']:.1%}" for v in values)+' |')
    lines.extend(['',
        'Calibration contiene 86 positivi: un errore vale circa 1,16 punti di recall, quindi i target osservati 99% e 100% richiedono entrambi zero errori in quel campione. Questo spiega perché una sola soglia ricavata dal minimo positivo è sensibile a pochi casi. I punti diagnostici sui vecchi fold non vengono usati per riaggiustarla.','',
        'Curve complete in [curve-points.json](curve-points.json). Brier ed ECE sono nel JSON e si riferiscono alle etichette deboli e ai soli input entro il contesto: gli score 1 assegnati per inoltrare gli overflow non sono trattati come probabilità del modello.','',
        ])
    if 'expandedCalibrationExploratory' in result:
        expanded=result['expandedCalibrationExploratory']
        lines.extend(['## Calibrazione ampliata: backtest secondario','',
            '**Analisi post-hoc esplorativa, separata dalla selezione principale.** Dopo aver visto le curve, si mantiene ogni testa invariata e si ricava la soglia dal minimo positivo di calibration + selection. Sono 750 esempi, con 215 positivi. Selection entra quindi nella calibrazione e non è più usato come misura di qualità di questa variante.','',
            'Le soglie non usano le etichette dei due fold finali, ma quei fold erano già stati esaminati nelle analisi precedenti: questo non è un nuovo test indipendente. Il vincitore della selezione principale e i suoi artefatti non vengono cambiati. Non vengono creati filtri da attivare automaticamente.','',
            '| Candidato, stessa banca di calibrazione | Positivi persi vecchia validazione | Scarti vecchia validazione | Positivi persi vecchio test | Scarti vecchio test |','|---|---:|---:|---:|---:|'])
        for name,c in expanded['candidates'].items():
            v=c['exploratoryEvaluation']['outer_validation'];t=c['exploratoryEvaluation']['exploratory_test']
            lines.append(f"| {name} | {v['falseNegative']}/{v['positiveExamples']} | {v['llmCallsAvoidedFraction']:.1%} | {t['falseNegative']}/{t['positiveExamples']} | {t['llmCallsAvoidedFraction']:.1%} |")
        lines.extend(['',
            'Il nuovo encoder con testa rifittata mostra quindi un vantaggio potenziale nel regime conservativo quando la soglia usa più positivi. Non basta per concludere che il problema sia risolto: servono giudizi umani e un periodo futuro separato. Le percentuali non sono una previsione del risparmio in produzione.','',
            'È disponibile solo in anteprima esplicita con `predict.py --directory .local-evals/mail-detection-followup --name tuned-head --calibration expanded-bank`. La soglia predefinita degli artefatti rimane quella dello studio principale. L’anteprima ampliata è stata verificata su un precedente falso negativo, un negativo e un overflow; non modifica mail o stato del promoter.',''])
    lines.extend([
        '## Revisione delle etichette','',
        'È pronto [human-review-blind.jsonl](human-review-blind.jsonl), senza punteggi o etichette storiche mostrate al revisore, e un [primo gruppo prioritario di 20 casi](human-review-priority20.jsonl), con [guida alla revisione](review-guide.md). Il pacchetto separato [human-review.jsonl](human-review.jsonl) conserva etichette deboli e motivi di selezione per il debug. Nessuna etichetta è stata cambiata automaticamente e non sono ancora presenti giudizi umani. I casi sono mirati a errori e disaccordi: non costituiscono un test indipendente.','',
        'Il target è promoteMail. Il valore degli allegati è una decisione indipendente e non è coperto integralmente da questo dataset. Un futuro gate dell’intera triage deve inoltrare i casi con allegati o essere valutato anche sul target unione mail/allegati. Le percentuali di scarto non stimano direttamente il risparmio economico del job.','',
        '## Altri paradigmi decisionali','',
        'Ricerca con fonti e vincoli verificati: [decision-models.md](decision-models.md). I risultati numerici qui sopra riguardano solo i candidati effettivamente eseguiti; non attribuiscono accuratezza sulle mail a OpenJev, Rizzo Flow o Laya.','',
        '## Verifiche e tempi','',
        f"Verificati i 132 tensori del checkpoint, la riproduzione del training e l’inferenza da testo di {len(verification['candidates'])} candidati, incluso l’inoltro oltre 8k. Lo scaler dei metadati usa solo optimization. Nessuna chiamata LLM a pagamento o modifica alle mail.",'',
        f"Tutti i {verification['changedTensorCount']} tensori esportati differiscono dal base: {verification['changedExportedParameters']:,} valori aggiornati su {verification['exportedParameters']:,}. La similarità coseno mediana fra embedding base e aggiornate è {verification['baseVsTunedEmbeddingCosineMedian']:.4f}; l’effetto del training è misurabile.",'',
        '| TF-IDF + metadati: token del testo | Mediana a modello caricato |','|---:|---:|'])
    for sample in verification['sparseWarmLatency']:lines.append(f"| {sample['actualTokens']} | {sample['medianSeconds']:.4f} s |")
    if result['tunedHeadProfiles']:
        lines.extend(['','| Encoder fine-tuned + nuova testa: token effettivi | Mediana, modello caricato |','|---:|---:|'])
        for sample in sorted(result['tunedHeadProfiles'],key=lambda r:r['actualTokens']):
            lines.append(f"| {sample['actualTokens']} | {sample['medianSeconds']:.4f} s |")
    lines.extend(['','Il GTE congelato misurato nel precedente studio su questo Mac impiegava circa 0,051 s a 512 token e 2,264 s a 7.900 token; è un riferimento precedente, non una nuova misura del modello fine-tuned.',''])
    try:
        os.environ.setdefault('MPLCONFIGDIR',str(OUT/'mpl-cache'))
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        points=json.loads((OUT/'curve-points.json').read_text());fig,axes=plt.subplots(1,3,figsize=(13,4),sharey=True)
        for ax,part in zip(axes,['selection','outer_validation','exploratory_test']):
            for name,p in points.items():
                p=p[part];recall=1-np.asarray(p['falseNegatives'])/p['positiveExamples'];avoided=(np.asarray(p['trueNegatives'])+np.asarray(p['falseNegatives']))/p['examples']
                keep=recall>=.95;levels=np.unique(recall[keep])
                envelope=np.asarray([avoided[keep&(recall==r)].max() for r in levels])
                ax.step(levels*100,envelope*100,where='pre',label=name)
            ax.set_title(part);ax.set_xlabel('Recall osservato (%)');ax.set_xlim(95,100);ax.set_ylim(0,85);ax.grid(alpha=.25)
        axes[0].set_ylabel('Scarti diagnostici (%)');axes[-1].legend(fontsize=6);fig.suptitle('Soglie oracle esplorative: non soglie operative');fig.tight_layout();fig.savefig(OUT/'high-recall-curves.svg');fig.savefig(OUT/'high-recall-curves.png',dpi=160);plt.close(fig)
        lines.extend(['![Curve esplorative nella regione ad alto recall](high-recall-curves.svg)',''])
    except ImportError:lines.extend(['Grafico non generato: matplotlib non presente; punti completi disponibili nel JSON.',''])
    (OUT/'comparison.md').write_text('\n'.join(lines))
    note='> Ultimo confronto: [teste rifittate, metadati e altri paradigmi](../mail-detection-followup/comparison.md).\n\n'
    for folder in ['mail-detection','mail-detection-v2','mail-detection-direct']:
        previous=OUT.parent/folder/'comparison.md'
        text=previous.read_text()
        if not text.startswith(note):previous.write_text(note+text)
    print('Report written:',OUT/'comparison.md')


if __name__=='__main__':main()
