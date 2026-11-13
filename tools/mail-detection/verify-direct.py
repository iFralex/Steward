"""Verify directly supervised checkpoints and actual preview inference locally."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import joblib
import numpy as np
from safetensors import safe_open

from direct import OUTPUT,SOURCE,context,guard,score_key
from metadata import metadata_features
from run import GTE,atomic_json


def feature_matrix(encoder,artifact,text):
    vector=encoder.encode([text])
    if 'metadata' in artifact:
        recipe=artifact['metadata']
        extra=recipe['scaler'].transform(metadata_features(text)[None,:])*recipe['weight']
        vector=np.concatenate([vector,extra],axis=1)
    return vector


def main():
    rows,digest,plan,splits,lengths=context()
    selected=json.loads((OUTPUT/'selection.json').read_text())
    evaluation=json.loads((OUTPUT/'evaluation.json').read_text())
    assert selected['testUsedForSelection'] is False and evaluation['testUsedForCheckpointOrDepthSelection'] is False
    schedule=json.loads((OUTPUT/'training-schedule.json').read_text())
    assert len(schedule)==len(set(schedule)) and set(schedule)<=set(splits['optimization'])
    checkpoints={}
    for layers in plan['depths']:
        folder=OUTPUT/f'direct-l{layers}'
        if not (folder/'done.json').exists():continue
        done=json.loads((folder/'done.json').read_text());best=json.loads((folder/'best.json').read_text())
        history=json.loads((folder/'history.json').read_text())
        assert done['datasetSha256']==digest
        assert done['uniqueLossExamples']==done['examplesSeen']
        assert score_key(best['cpu'])==min(score_key(point) for point in history)
        config=json.loads((folder/'encoder/adapter_config.json').read_text())
        assert config['updatedLayers']==(list(range(12-layers,12)) if best['examplesSeen'] else [])
        with safe_open(str(folder/'encoder/adapter.safetensors'),framework='np') as f:
            keys=f.keys()
            assert len(keys)==11*len(config['updatedLayers'])
            assert all(np.isfinite(f.get_tensor(key)).all() for key in keys)
        with (folder/'encoder/adapter.safetensors').open('rb') as stream:
            checksum=hashlib.file_digest(stream,'sha256').hexdigest()
        gpu=json.loads((folder/'gpu-validation.json').read_text())
        assert checksum==gpu['encoder']['fineTunedWeightsSha256']
        checkpoints[str(layers)]={'finiteWeights':True,'updatedTensorCount':len(keys),'bestExamplesSeen':best['examplesSeen'],
                                  'lossExamplesUniqueAndOptimizationOnly':True,'bestCheckpointMatchesHistory':True}
    attempts=[];trajectory=None
    log=OUTPUT/'logs/train-l12.log'
    for line in log.read_text().splitlines() if log.exists() else []:
        if not line.startswith('{'):continue
        event=json.loads(line)
        if event['event']=='direct_train_start':attempts.append({'start':event,'steps':{}})
        elif event['event']=='direct_training' and attempts:attempts[-1]['steps'][event['examplesSeen']]=event
    original=next((a for a in attempts if 'frozenVocabulary' not in a['start'] and a['steps']),None)
    compact=next((a for a in reversed(attempts) if 'frozenVocabulary' in a['start'] and a['steps']),None)
    if original and compact:
        assert compact['start']['frozenVocabulary']['exactRoundTripVerified']
        common=sorted(set(original['steps'])&set(compact['steps']))
        assert common
        maximum_trajectory_delta=max(abs(original['steps'][i][key]-compact['steps'][i][key])
            for i in common for key in ['loss','gradientNorm'])
        assert maximum_trajectory_delta<1e-6
        trajectory={'throughExamples':common[-1],'matchingLoggedSteps':len(common),
                    'maximumLossOrGradientDelta':maximum_trajectory_delta,'allVocabularyValuesExactRoundTrip':True}
    name=selected['selectedOnValidation'];artifact=joblib.load(OUTPUT/name/'classifier-conservative.joblib')
    assert artifact['datasetSha256']==digest and name==evaluation['selected']
    scores=np.load(OUTPUT/'final-scores.npy')
    eligible=[i for i in splits['exploratory_test'] if lengths[i]<=1536]
    positives=[i for i in eligible if rows[i]['label']==1 and scores[i]>=artifact['threshold']]
    negatives=[i for i in eligible if rows[i]['label']==0 and scores[i]<artifact['threshold']]
    chosen=[max(positives,key=lambda i:scores[i]),min(negatives,key=lambda i:scores[i]),int(np.flatnonzero(lengths>8192)[0])]
    payload=''.join(json.dumps({'text':rows[i]['text']},ensure_ascii=True)+'\n' for i in chosen)
    completed=subprocess.run([sys.executable,str(Path(__file__).with_name('predict.py')),'--directory',str(OUTPUT),'--name',name],
                             input=payload,text=True,capture_output=True,check=True)
    previews=[json.loads(line) for line in completed.stdout.splitlines()]
    assert [r['route'] for r in previews]==['llm','discard_candidate','llm']
    assert all(r['previewOnly'] for r in previews) and previews[2]['reason']=='context_overflow'
    delta=max(abs(previews[j]['score']-scores[i]) for j,i in enumerate(chosen[:2]))
    assert delta<.01
    if 'metadata' in artifact:
        raw=np.stack([metadata_features(row['text']) for row in rows]);ids=[i for i in splits['optimization'] if lengths[i]<=8192]
        assert int(artifact['metadata']['scaler'].n_samples_seen_)==len(ids)
        assert np.allclose(artifact['metadata']['scaler'].mean_,raw[ids].mean(axis=0,dtype=np.float64),atol=1e-10)
    atomic_json(OUTPUT/'verification.json',{'checkpoints':checkpoints,'selectedPreviewVerified':True,
                'maximumCachedScoreDelta':float(delta),'preview':previews,'lossScheduleOptimizationOnly':True,
                'compactVocabularyTrajectory':trajectory,
                'testUsedForModelSelection':False,'paidLlmCalls':0,'mailActions':0})
    print('Selected preview, overflow, loss isolation and all completed checkpoints verified.',flush=True)
    encoder=GTE(artifact['encoder'].get('fineTuned'))
    assert encoder.provenance==artifact['encoder']
    samples=[]
    for budget in [128,512,2048,4096,8192]:
        guard();candidates=np.flatnonzero(lengths<=budget);i=int(max(candidates,key=lambda i:lengths[i]))
        def infer():
            return artifact['classifier'].predict_proba(feature_matrix(encoder,artifact,rows[i]['text']))
        infer();times=[]
        for _ in range(3):
            started=time.perf_counter();infer();times.append(time.perf_counter()-started)
        samples.append({'requestedTokens':budget,'actualTokens':int(lengths[i]),'medianSeconds':float(np.median(times)),'maxSeconds':max(times)})
        print(json.dumps({'event':'direct_profile',**samples[-1]}),flush=True)
    atomic_json(OUTPUT/'profile.json',{'selected':name,'encoder':encoder.provenance,'samples':samples,
                'resources':encoder.memory(),'includesHeadAndMetadata':True,'note':'Warm local detector, three timed runs on one real thread per target; other Mac services active.'})


if __name__=='__main__':main()
