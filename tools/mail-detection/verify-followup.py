"""Verify the replay, split isolation and actual text inference of every candidate."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import joblib
import numpy as np
from safetensors import safe_open
from scipy import sparse

from followup import OUT,setup
from metadata import metadata_features
from run import atomic_json,CACHE,REVISION


def main():
    rows,digest,plan,splits,lengths=setup()
    done=json.loads((OUT/'checkpoint256/done.json').read_text())
    assert done['datasetSha256']==digest and done['examplesSeen']==256
    assert done['lossOptimizationOnly'] and done['schedulePreserved']
    assert len(done['trajectory'])==16 and max(p['maximumReferenceDelta'] for p in done['trajectory'])<1e-6
    config=json.loads((OUT/'checkpoint256/encoder/adapter_config.json').read_text())
    assert config['updatedLayers']==list(range(12))
    changed=0;parameters=0;changed_tensors=0
    with safe_open(str(OUT/'checkpoint256/encoder/adapter.safetensors'),framework='np') as f, \
         safe_open(str(CACHE/f'models--Alibaba-NLP--gte-multilingual-base/snapshots/{REVISION}/model.safetensors'),framework='np') as base:
        assert len(f.keys())==132
        for k in f.keys():
            value=f.get_tensor(k);assert np.isfinite(value).all()
            original=base.get_tensor(k if k in base.keys() else 'new.'+k)
            count=int(np.count_nonzero(value!=original));changed+=count;parameters+=value.size;changed_tensors+=int(count>0)
    assert changed>0
    selection=json.loads((OUT/'selection.json').read_text());evaluation=json.loads((OUT/'evaluation.json').read_text())
    assert selection['finalFoldsUsed'] is False and evaluation['selectionFixedBeforeFinalEvaluation']
    assert selection['selected']==evaluation['selected']
    a=np.load(OUT/'base-meta-scores.npy');b=np.load(OUT/'sparse-text-meta-scores.npy');consensus=np.load(OUT/'consensus-scores.npy')
    assert np.array_equal(consensus>=.5,(a>=selection['candidates']['base-meta']['threshold'])|
        (b>=selection['candidates']['sparse-text-meta']['threshold']))
    train=[i for i in splits['optimization'] if lengths[i]<=8192]
    raw=np.stack([metadata_features(r['text']) for r in rows]);verified={}
    overflow=int(np.flatnonzero(lengths>8192)[0])
    for name in selection['candidates']:
        scores=np.load(OUT/f'{name}-scores.npy');artifact=joblib.load(OUT/name/'classifier-conservative.joblib')
        assert artifact['datasetSha256']==digest
        assert np.all(scores[lengths>8192]==1.)
        if 'metadata' in artifact:
            scaler=artifact['metadata']['scaler']
            assert int(scaler.n_samples_seen_)==len(train)
            assert np.allclose(scaler.mean_,raw[train].mean(axis=0,dtype=np.float64),atol=1e-10)
        short=[i for i in splits['selection'] if lengths[i]<=1024]
        ids=[max(short,key=lambda i:scores[i]),min(short,key=lambda i:scores[i]),overflow]
        payload=''.join(json.dumps({'text':rows[i]['text']},ensure_ascii=True)+'\n' for i in ids)
        completed=subprocess.run([sys.executable,str(Path(__file__).with_name('predict.py')),'--directory',str(OUT),'--name',name],
            input=payload,text=True,capture_output=True,check=True)
        predictions=[json.loads(line) for line in completed.stdout.splitlines()]
        expected=['llm' if scores[i]>=artifact['threshold'] else 'discard_candidate' for i in ids[:2]]+['llm']
        assert [p['route'] for p in predictions]==expected
        assert predictions[-1]['reason']=='context_overflow' and all(p['previewOnly'] for p in predictions)
        delta=max(abs(predictions[j]['score']-scores[i]) for j,i in enumerate(ids[:2]))
        assert delta<.01
        verified[name]={'actualTextInference':True,'maximumCachedScoreDelta':float(delta),'overflowForwarded':True}
        print(json.dumps({'event':'followup_verified','name':name,**verified[name]}),flush=True)
    with (OUT/'human-review-blind.jsonl').open() as stream:blind=[json.loads(line) for line in stream]
    assert blind and all(r['humanLabel'] is None and 'historicalWeakLabel' not in r for r in blind)
    assert len({r['rowIndex'] for r in blind})==len(blind)
    assert all(r['text']==rows[r['rowIndex']]['text'] for r in blind)
    with (OUT/'human-review-priority20.jsonl').open() as stream:priority=[json.loads(line) for line in stream]
    assert priority==blind[:20]
    # Measure a second paradigm without loading an encoder or timing startup.
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(str(CACHE/f'models--Alibaba-NLP--gte-multilingual-base/snapshots/{REVISION}'),local_files_only=True)
    artifact=joblib.load(OUT/'sparse-text-meta/classifier-conservative.joblib');samples=[]
    for budget in [512,4096,8192]:
        i=int(max(np.flatnonzero(lengths<=budget),key=lambda i:lengths[i]));times=[]
        for _ in range(4):
            started=time.perf_counter();tokens=len(tokenizer(rows[i]['text'],truncation=False)['input_ids']);assert tokens<=8192
            extra=artifact['metadata']['scaler'].transform(metadata_features(rows[i]['text'])[None,:])*artifact['metadata']['weight']
            features=sparse.hstack([artifact['vectorizer'].transform([rows[i]['text']]),sparse.csr_matrix(extra)],format='csr')
            artifact['classifier'].predict_proba(features);times.append(time.perf_counter()-started)
        samples.append({'actualTokens':int(lengths[i]),'medianSeconds':float(np.median(times[1:]))})
    from direct import SOURCE
    base=np.load(SOURCE/'gte/features.npy')[lengths<=8192];tuned=np.load(OUT/'tuned/features.npy')[lengths<=8192]
    cosine=np.sum(base*tuned,axis=1)
    atomic_json(OUT/'verification.json',{'replayedEncoderTensorCount':132,'finiteWeights':True,
        'changedExportedParameters':changed,'exportedParameters':parameters,'changedTensorCount':changed_tensors,
        'baseVsTunedEmbeddingCosineMedian':float(np.median(cosine)),'baseVsTunedEmbeddingCosineMinimum':float(cosine.min()),
        'originalTrajectoryMatchedThrough256':True,'lossAndScalerOptimizationOnly':True,'candidates':verified,
        'blindReviewPrepared':len(blind),'reviewPacketSourceMatched':True,'humanLabelsProvided':0,'sparseWarmLatency':samples,
        'paidLlmCalls':0,'mailActions':0,'externalMailUploads':0})


if __name__=='__main__':main()
