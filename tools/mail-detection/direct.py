"""Direct BCE fine-tuning with nested validation and conditional depth search.

Only optimization rows enter the loss. Calibration sets the threshold; selection
chooses checkpoints/depth. The already examined v2 test is exploratory only.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import signal
import subprocess
import sys
import time

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from direct_model import DirectHead
from metadata import FEATURE_NAMES, metadata_features
from run import CACHE, CODE_REVISION, GTE, REVISION, ROOT, atomic_json, load_dataset, metrics

SOURCE = ROOT / '.local-evals/mail-detection-v2'
OUTPUT = ROOT / '.local-evals/mail-detection-direct'
PYTHON = ROOT / '.local-evals/mail-detection/venv/bin/python'
SEED = 20261104
DISK_RESERVE = 512 * 1024**2


def emit(event, **values):
    print(json.dumps({'event': event, **values}), flush=True)


def guard(extra=0):
    if shutil.disk_usage(OUTPUT).free < DISK_RESERVE + extra:
        raise RuntimeError('Less than 512 MiB reserve plus checkpoint space; existing best checkpoints are retained.')


def score_key(result):
    m = result['selection']
    return (m['falseNegative'], -m['trueNegative'], result.get('selectionLogLoss', 0.))


def measured(rows, scores, splits):
    labels = np.asarray([r['label'] for r in rows])
    calibration = np.asarray(splits['calibration'])
    selection = np.asarray(splits['selection'])
    threshold = float(np.min(scores[calibration[labels[calibration] == 1]]))
    probability = np.clip(scores[selection], 1e-7, 1-1e-7)
    loss = -np.mean(labels[selection]*np.log(probability)+(1-labels[selection])*np.log1p(-probability))
    return {'threshold': threshold,
            'calibration': metrics(labels[calibration], scores[calibration], threshold),
            'selection': metrics(labels[selection], scores[selection], threshold),
            'selectionLogLoss': float(loss)}


def context():
    rows, digest = load_dataset(SOURCE)
    assert len({r['groupHash'] for r in rows}) == len(rows)
    plan = json.loads((OUTPUT / 'plan.json').read_text())
    if plan['datasetSha256'] != digest:
        raise RuntimeError('Frozen source dataset changed')
    splits = json.loads((OUTPUT / 'splits.json').read_text())
    lengths = np.load(SOURCE / 'gte/token-lengths.npy')
    return rows, digest, plan, splits, lengths


def prepare():
    OUTPUT.mkdir(exist_ok=True, mode=0o700)
    os.chmod(OUTPUT, 0o700)
    if (OUTPUT / 'prepared.json').exists():
        context()
        emit('direct_preparation_cached')
        return
    rows, digest = load_dataset(SOURCE)
    lengths = np.load(SOURCE / 'gte/token-lengths.npy')
    features = np.load(SOURCE / 'gte/features.npy')
    labels = np.asarray([r['label'] for r in rows])
    rng = random.Random(SEED)
    reviewed = {34759, 30365, 111, 1713}
    original_train = [i for i, r in enumerate(rows) if r['split'] == 'train']
    splits = {'optimization': [], 'calibration': [], 'selection': []}
    for label in [0, 1]:
        candidates = [i for i in original_train if labels[i] == label and rows[i]['threadId'] not in reviewed]
        rng.shuffle(candidates)
        n_cal = round(300 * sum(labels[original_train] == label) / len(original_train))
        n_select = round(450 * sum(labels[original_train] == label) / len(original_train))
        splits['calibration'].extend(candidates[:n_cal])
        splits['selection'].extend(candidates[n_cal:n_cal+n_select])
    reserved = set(splits['calibration'] + splits['selection'])
    splits['optimization'] = [i for i in original_train if i not in reserved]
    splits['outer_validation'] = [i for i, r in enumerate(rows) if r['split'] == 'validation']
    splits['exploratory_test'] = [i for i, r in enumerate(rows) if r['split'] == 'test']
    for name in splits:
        splits[name].sort()
    sets = list(map(set, splits.values()))
    assert all(not a & b for i, a in enumerate(sets) for b in sets[i+1:])
    assert all(rows[i]['split'] == 'train' for name in ['optimization','calibration','selection'] for i in splits[name])
    train = np.asarray([i for i in splits['optimization'] if lengths[i] <= 8192])
    init = LogisticRegression(C=1., max_iter=2000, random_state=SEED).fit(features[train], labels[train])
    joblib.dump(init, OUTPUT / 'initial-head.joblib')
    initial_scores = init.predict_proba(features)[:, 1]
    # Half hard, half period-diverse random examples in each class. Every loss
    # example is unique and comes from optimization, never calibration/selection.
    by_label = {}
    per_class = min(512, *(sum(labels[train] == label) for label in [0, 1]))
    per_class -= per_class % 2
    for label in [0, 1]:
        candidates = [int(i) for i in train if labels[i] == label]
        candidates.sort(key=lambda i: initial_scores[i], reverse=label == 0)
        hard = candidates[:per_class//2]
        remaining = candidates[per_class//2:]
        buckets = {}
        for i in remaining:
            year = rows[i]['text'].split('\n\n', 1)[-1][:8]
            buckets.setdefault(year, []).append(i)
        for bucket in buckets.values():
            rng.shuffle(bucket)
        diverse = []
        while len(diverse) < per_class-len(hard):
            for key in sorted(buckets):
                if buckets[key] and len(diverse) < per_class-len(hard):
                    diverse.append(buckets[key].pop())
        by_label[label] = hard + diverse
        rng.shuffle(by_label[label])
    schedule = [i for pair in zip(by_label[0], by_label[1]) for i in pair]
    assert len(schedule) == len(set(schedule)) and len(schedule) % 4 == 0
    plan = {'datasetSha256': digest, 'seed': SEED, 'source': str(SOURCE),
            'baseRevision': REVISION, 'codeRevision': CODE_REVISION,
            'depths': [2, 6, 12], 'examples': len(schedule), 'gradientAccumulation': 4,
            'checkpointsAtExamples': sorted({0, min(256,len(schedule)), min(512,len(schedule)), len(schedule)}),
            'encoderTopLearningRate': 2e-5, 'headLearningRate': 1e-3, 'layerLearningRateDecay': .85,
            'earlyStoppingPatience': 2, 'inputEmbeddingMatrixFrozen': True,
            'maxTokens': 8192, 'trainingDevice': 'cpu', 'checkpointSelectionDevice': 'cpu',
            'deploymentValidationDevice': 'mps if available; float16 encoder',
            'depthGate': 'At least 99% selection recall and fewer missed positives without >1pp discard loss, or no more misses and >=3pp discard gain versus best refitted frozen baseline. A trained checkpoint must win.',
            'previouslyInspectedTestIsExploratory': True,
            'reviewedTrainingCasesExcludedFromNewHoldouts': sorted(reviewed),
            'checkpointsStoreUpdatedLayersOnly': True}
    atomic_json(OUTPUT / 'plan.json', plan)
    atomic_json(OUTPUT / 'splits.json', splits)
    atomic_json(OUTPUT / 'training-schedule.json', schedule)
    # Frozen controls are refitted on exactly the same optimization rows.
    raw = np.stack([metadata_features(r['text']) for r in rows])
    scaler = StandardScaler().fit(raw[train])
    transformed = scaler.transform(raw)
    encoder = json.loads((SOURCE / 'gte/manifest.json').read_text())['encoder']
    controls = []
    for name, weights in [('direct-frozen', [0.]), ('direct-frozen-meta', [0.,.01,.03,.1,.3,1.])]:
        candidates = []
        for weight in weights:
            x = features if weight == 0 and name == 'direct-frozen' else np.concatenate([features, transformed*weight], axis=1)
            for c in [.1,1.,10.,100.]:
                classifier = LogisticRegression(C=c,max_iter=2000,random_state=SEED).fit(x[train],labels[train])
                scores = classifier.predict_proba(x)[:,1]
                scores[lengths>8192] = 1.
                result = measured(rows,scores,splits)
                candidates.append((result['calibration']['llmCallsAvoidedFraction'],-c,-weight,classifier,result,weight))
        _,_,_,classifier,result,weight = max(candidates,key=lambda x:x[:3])
        target = OUTPUT/name
        target.mkdir(exist_ok=True)
        artifact = {'classifier':classifier,'threshold':result['threshold'],'encoder':encoder,'maxTokens':8192,'datasetSha256':digest}
        if name.endswith('-meta'):
            artifact['metadata'] = {'version':1,'featureNames':FEATURE_NAMES,'scaler':scaler,'weight':weight}
        for filename in ['classifier.joblib','classifier-conservative.joblib']:
            joblib.dump(artifact,target/filename)
        result.update(name=name,encoder=encoder,metadataScale=weight,classifierC=classifier.C)
        atomic_json(target/'gpu-validation.json',result)
        controls.append(name)
    name = 'direct-frozen-c1'
    target = OUTPUT/name
    target.mkdir(exist_ok=True)
    head = DirectHead(init.coef_.astype(np.float32),init.intercept_.astype(np.float32))
    scores = head.predict_proba(features)[:,1];scores[lengths>8192]=1.
    result = measured(rows,scores,splits);result.update(name=name,encoder=encoder)
    artifact = {'classifier':head,'threshold':result['threshold'],'encoder':encoder,'maxTokens':8192,'datasetSha256':digest}
    for filename in ['classifier.joblib','classifier-conservative.joblib']:joblib.dump(artifact,target/filename)
    atomic_json(target/'gpu-validation.json',result)
    controls.append(name)
    atomic_json(OUTPUT/'prepared.json',{'datasetSha256':digest,'controls':controls,
                'splitCounts':{name:{'total':len(ids),'positive':int(labels[ids].sum())} for name,ids in splits.items()}})
    emit('direct_prepared',examples=len(schedule),splitCounts=json.loads((OUTPUT/'prepared.json').read_text())['splitCounts'])


def cpu_vectors(model,tokenizer,rows,lengths,indices,torch,max_batch=4):
    matrix = np.zeros((len(rows),768),dtype=np.float32)
    pending = sorted([i for i in indices if lengths[i] <= 8192],key=lambda i:lengths[i])
    model.eval()
    position = 0
    with torch.inference_mode():
        while position < len(pending):
            guard()
            batch = [pending[position]];position += 1
            while position < len(pending) and len(batch)<max_batch and lengths[pending[position]]*(len(batch)+1)<=8192:
                batch.append(pending[position]);position+=1
            encoded = tokenizer([rows[i]['text'] for i in batch],padding=True,truncation=False,return_tensors='pt')
            assert encoded['input_ids'].shape[1] <= 8192
            output = model(**encoded).last_hidden_state[:,0].float()
            matrix[batch] = torch.nn.functional.normalize(output,dim=-1).cpu().numpy()
            if position%100<len(batch) or position==len(pending):
                emit('direct_cpu_evaluation_progress',done=position,total=len(pending))
    return matrix


def save_best(model,head,target,layers,seen,result,torch):
    from safetensors.torch import save_file
    encoder_dir=target/'encoder';encoder_dir.mkdir(exist_ok=True)
    updates = {name:p.detach().to(dtype=torch.float16).contiguous() for name,p in model.named_parameters() if p.requires_grad} if seen else {}
    assert all(torch.isfinite(value).all() for value in updates.values())
    bytes_needed=sum(v.numel()*v.element_size() for v in updates.values())+65536
    path=encoder_dir/'adapter.safetensors'
    free=shutil.disk_usage(OUTPUT).free
    # The previous checkpoint is obsolete only after a better selection score.
    if free < DISK_RESERVE+bytes_needed and path.exists() and free+path.stat().st_size >= DISK_RESERVE+bytes_needed:
        path.unlink()
    guard(bytes_needed)
    temporary=encoder_dir/'adapter.tmp.safetensors';save_file(updates,str(temporary));temporary.replace(path)
    atomic_json(encoder_dir/'adapter_config.json',{'baseRevision':REVISION,'codeRevision':CODE_REVISION,
                'updatedLayers':list(range(12-layers,12)) if seen else [],'maxSequenceLength':8192})
    np.savez(target/'head.npz',weight=head.weight.detach().numpy(),bias=head.bias.detach().numpy())
    atomic_json(target/'best.json',{'examplesSeen':seen,'layers':layers,'cpu':result,'exportPrecision':'float16',
                'checkpointThenRecalibratedOnGpu':True})


def compact_frozen_vocabulary(model,torch):
    from functools import partial
    # The pinned base stores this frozen table in FP16. Verify exact round-trip
    # before retaining FP16 storage and returning only lookup rows in FP32.
    embedding=model.get_input_embeddings()
    assert not embedding.weight.requires_grad
    weight=embedding.weight.detach()
    for start in range(0,weight.shape[0],4096):
        chunk=weight[start:start+4096]
        assert torch.equal(chunk,chunk.half().float()), 'Frozen vocabulary is not losslessly representable in FP16'
    saved=weight.numel()*2
    del weight
    embedding.to(dtype=torch.float16)
    embedding.register_forward_hook(lambda module,inputs,output:output.float())
    # Transformers otherwise derives the attention-mask dtype from the first
    # parameter, now the compact table. Attention computation stays FP32.
    model.get_extended_attention_mask=partial(model.get_extended_attention_mask,dtype=torch.float32)
    assert model.get_extended_attention_mask(torch.tensor([[1,0]]),(1,2)).dtype==torch.float32
    assert embedding(torch.tensor([[0,1]])).dtype==torch.float32
    return {'storage':'float16','lookupOutput':'float32','exactRoundTripVerified':True,'parameterBytesSaved':saved}


def train(layers):
    import torch
    from transformers import AutoModel,AutoTokenizer
    from transformers.optimization import Adafactor
    rows,digest,plan,splits,lengths=context()
    target=OUTPUT/f'direct-l{layers}';target.mkdir(exist_ok=True)
    if (target/'done.json').exists():
        assert json.loads((target/'done.json').read_text())['datasetSha256']==digest
        emit('direct_training_cached',layers=layers);return
    guard()
    torch.set_num_threads(4);torch.manual_seed(SEED)
    base=str(CACHE/f'models--Alibaba-NLP--gte-multilingual-base/snapshots/{REVISION}')
    tokenizer=AutoTokenizer.from_pretrained(base,local_files_only=True)
    model=AutoModel.from_pretrained(base,trust_remote_code=True,code_revision=CODE_REVISION,cache_dir=str(CACHE),
          local_files_only=True,attn_implementation='sdpa',torch_dtype=torch.float32).cpu()
    model.requires_grad_(False)
    vocabulary=compact_frozen_vocabulary(model,torch)
    for layer in model.encoder.layer[-layers:]:layer.requires_grad_(True)
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant':False})
    initial=joblib.load(OUTPUT/'initial-head.joblib')
    head=torch.nn.Linear(768,1)
    with torch.no_grad():
        head.weight.copy_(torch.from_numpy(initial.coef_.astype(np.float32)))
        head.bias.copy_(torch.from_numpy(initial.intercept_.astype(np.float32)))
    groups=[]
    for index,layer in enumerate(model.encoder.layer):
        if index < 12-layers:continue
        for decay in [False,True]:
            parameters=[p for name,p in layer.named_parameters() if p.requires_grad and (p.ndim>1)==decay]
            groups.append({'params':parameters,'lr':plan['encoderTopLearningRate']*plan['layerLearningRateDecay']**(11-index),
                           'weight_decay':.01 if decay else 0.})
    groups.append({'params':list(head.parameters()),'lr':plan['headLearningRate'],'weight_decay':0.})
    optimizer_name=plan.get('optimizerByDepth',{}).get(str(layers),'AdamW')
    optimizer=(Adafactor(groups,relative_step=False,scale_parameter=False,warmup_init=False)
               if optimizer_name=='Adafactor' else torch.optim.AdamW(groups))
    eval_batch=plan.get('cpuEvaluationBatchSizeByDepth',{}).get(str(layers),4)
    learning_rates=[g['lr'] for g in groups]
    schedule=json.loads((OUTPUT/'training-schedule.json').read_text())
    train_set=set(splits['optimization'])
    assert all(i in train_set and rows[i]['split']=='train' and lengths[i]<=8192 for i in schedule)
    evaluated=splits['calibration']+splits['selection']
    baseline_cache=OUTPUT/'cpu-base-validation.npy'
    if baseline_cache.exists():features=np.load(baseline_cache)
    else:
        features=cpu_vectors(model,tokenizer,rows,lengths,evaluated,torch,max_batch=eval_batch);np.save(baseline_cache,features)
    scorer=DirectHead(head.weight.detach().numpy(),head.bias.detach().numpy())
    scores=scorer.predict_proba(features)[:,1];scores[lengths>8192]=1.
    initial_result=measured(rows,scores,splits)
    best=json.loads((target/'best.json').read_text())['cpu'] if (target/'best.json').exists() else None
    if best is None or score_key(initial_result)<score_key(best):
        best=initial_result;save_best(model,head,target,layers,0,best,torch)
    history=[{'examplesSeen':0,**initial_result}]
    started=time.perf_counter();total_updates=len(schedule)//4;warmup=max(1,round(total_updates*.1))
    trainable=sum(p.numel() for p in model.parameters() if p.requires_grad)
    emit('direct_train_start',layers=layers,encoderTrainableParameters=trainable,headParameters=769,
         examples=len(schedule),checkpoints=plan['checkpointsAtExamples'],device='cpu',contextTokens=8192,
         optimizer=optimizer_name,cpuEvaluationBatchSize=eval_batch,frozenVocabulary=vocabulary)
    stale=0;losses=[];seen=0
    model.train();head.train();optimizer.zero_grad(set_to_none=True)
    for step in range(total_updates):
        guard()
        ratio=min(1.,(step+1)/warmup) if step<warmup else max(0.,(total_updates-step)/(total_updates-warmup))
        for group,lr in zip(optimizer.param_groups,learning_rates):group['lr']=lr*ratio
        for i in schedule[step*4:(step+1)*4]:
            encoded=tokenizer(rows[i]['text'],truncation=False,return_tensors='pt')
            assert encoded['input_ids'].shape[1]==lengths[i] and lengths[i]<=8192
            vector=torch.nn.functional.normalize(model(**encoded).last_hidden_state[:,0].float(),dim=-1)
            logit=head(vector).reshape(1)
            loss=torch.nn.functional.binary_cross_entropy_with_logits(logit,torch.tensor([float(rows[i]['label'])]))
            if not torch.isfinite(loss):raise RuntimeError('Non-finite classification loss')
            (loss/4).backward();losses.append(float(loss.detach()));seen+=1
        norm=torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad]+list(head.parameters()),1.)
        if not torch.isfinite(norm):raise RuntimeError('Non-finite gradients')
        optimizer.step();optimizer.zero_grad(set_to_none=True)
        if seen%16==0:emit('direct_training',layers=layers,examplesSeen=seen,total=len(schedule),loss=float(np.mean(losses[-16:])),
                           gradientNorm=float(norm),freeDiskGiB=shutil.disk_usage(OUTPUT).free/1024**3)
        if seen in plan['checkpointsAtExamples']:
            emit('direct_checkpoint_evaluation_start',layers=layers,examplesSeen=seen)
            features=cpu_vectors(model,tokenizer,rows,lengths,evaluated,torch,max_batch=eval_batch)
            scorer=DirectHead(head.weight.detach().numpy(),head.bias.detach().numpy())
            scores=scorer.predict_proba(features)[:,1];scores[lengths>8192]=1.
            result=measured(rows,scores,splits);history.append({'examplesSeen':seen,**result})
            improved=score_key(result)<score_key(best)
            if improved:best=result;save_best(model,head,target,layers,seen,result,torch);stale=0
            else:stale+=1
            atomic_json(target/'history.json',history)
            emit('direct_checkpoint_evaluated',layers=layers,examplesSeen=seen,improved=improved,
                 selection=result['selection'],calibration=result['calibration'])
            model.train();head.train()
            if seen>=512 and stale>=plan['earlyStoppingPatience']:
                emit('direct_early_stopping',layers=layers,examplesSeen=seen);break
    atomic_json(target/'done.json',{'datasetSha256':digest,'layers':layers,'examplesSeen':seen,'uniqueLossExamples':seen,
                'encoderTrainableParameters':trainable,'headParameters':769,'seconds':time.perf_counter()-started,
                'trainingDevice':'cpu','loss':'BCEWithLogitsLoss','optimizer':optimizer_name,
                'cpuEvaluationBatchSize':eval_batch,'earlyStopped':seen<len(schedule),
                'frozenVocabulary':vocabulary,
                'bestExamplesSeen':json.loads((target/'best.json').read_text())['examplesSeen'],
                'trainingScriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
    emit('direct_training_complete',layers=layers,examplesSeen=seen)


def gpu_vectors(encoder,rows,lengths,indices):
    matrix=np.zeros((len(rows),768),dtype=np.float32)
    pending=sorted([i for i in indices if lengths[i]<=8192],key=lambda i:lengths[i])
    position=0
    while position<len(pending):
        guard()
        batch=[pending[position]];position+=1
        while position<len(pending) and len(batch)<4 and lengths[pending[position]]*(len(batch)+1)<=4096:
            batch.append(pending[position]);position+=1
        matrix[batch]=encoder.encode([rows[i]['text'] for i in batch])
        if position%100<len(batch) or position==len(pending):emit('direct_inference_progress',done=position,total=len(pending))
    return matrix


def evaluate(layers):
    rows,digest,plan,splits,lengths=context();name=f'direct-l{layers}';target=OUTPUT/name
    if (target/'gpu-validation.json').exists():emit('direct_gpu_validation_cached',layers=layers);return
    best=json.loads((target/'best.json').read_text())
    config=json.loads((target/'encoder/adapter_config.json').read_text())
    if best['examplesSeen']==0:
        from safetensors import safe_open
        assert config['updatedLayers']==[] and config['baseRevision']==REVISION and config['codeRevision']==CODE_REVISION
        with safe_open(str(target/'encoder/adapter.safetensors'),framework='np') as f:assert len(f.keys())==0
        manifest=json.loads((SOURCE/'gte/manifest.json').read_text())
        assert manifest['datasetSha256']==digest and manifest['maxTokens']==8192
        provenance=dict(manifest['encoder'])
        assert provenance['revision']==REVISION and provenance['codeRevision']==CODE_REVISION and provenance['fineTuned'] is None
        provenance['fineTuned']=str(target/'encoder')
        with (target/'encoder/adapter.safetensors').open('rb') as stream:
            provenance['fineTunedWeightsSha256']=hashlib.file_digest(stream,'sha256').hexdigest()
        provenance['fineTunedFormat']='partial-transformer-layers'
        features=np.load(SOURCE/'gte/features.npy')
        source='verified identical frozen GPU cache: zero updated tensors'
        emit('direct_identical_encoder_cache_reused',layers=layers)
    else:
        encoder=GTE(target/'encoder');provenance=encoder.provenance
        features=gpu_vectors(encoder,rows,lengths,splits['calibration']+splits['selection'])
        source='fresh exported-checkpoint GPU inference'
    values=np.load(target/'head.npz');head=DirectHead(values['weight'],values['bias'])
    scores=head.predict_proba(features)[:,1];scores[lengths>8192]=1.
    result=measured(rows,scores,splits);result.update(name=name,encoder=provenance,encoderFeatureSource=source,
                checkpoint=best,training=json.loads((target/'done.json').read_text()))
    artifact={'classifier':head,'threshold':result['threshold'],'encoder':provenance,'maxTokens':8192,
              'datasetSha256':digest,'trainingMethod':'direct-supervised-BCE','calibrationScope':'new calibration only'}
    for filename in ['classifier.joblib','classifier-conservative.joblib']:joblib.dump(artifact,target/filename)
    atomic_json(target/'gpu-validation.json',result)
    np.save(target/'validation-embeddings.npy',features)
    emit('direct_gpu_validation_complete',layers=layers,selection=result['selection'],checkpointExamples=result['checkpoint']['examplesSeen'])


def adequate(candidate,baseline):
    a,b=candidate['selection'],baseline['selection']
    if candidate.get('checkpoint',{}).get('examplesSeen',0)==0 or a['recallKeep']<.99:return False
    return ((a['falseNegative']<b['falseNegative'] and a['llmCallsAvoidedFraction']>=b['llmCallsAvoidedFraction']-.01)
        or (a['falseNegative']<=b['falseNegative'] and a['llmCallsAvoidedFraction']>=b['llmCallsAvoidedFraction']+.03))


def finish():
    rows,digest,plan,splits,lengths=context()
    choice=json.loads((OUTPUT/'selection.json').read_text());name=choice['selectedOnValidation']
    artifact=joblib.load(OUTPUT/name/'classifier-conservative.joblib')
    if name.startswith('direct-frozen'):
        features=np.load(SOURCE/'gte/features.npy')
        if 'metadata' in artifact:
            recipe=artifact['metadata'];raw=np.stack([metadata_features(r['text']) for r in rows])
            features=np.concatenate([features,recipe['scaler'].transform(raw)*recipe['weight']],axis=1)
    else:
        encoder=GTE(OUTPUT/name/'encoder')
        assert encoder.provenance==artifact['encoder']
        features=gpu_vectors(encoder,rows,lengths,splits['outer_validation']+splits['exploratory_test'])
    scores=artifact['classifier'].predict_proba(features)[:,1];scores[lengths>8192]=1.
    np.save(OUTPUT/'final-scores.npy',scores)
    labels=np.asarray([r['label'] for r in rows])
    evaluation={part:metrics(labels[splits[part]],scores[splits[part]],artifact['threshold']) for part in ['outer_validation','exploratory_test']}
    baseline_evaluation={}
    cached=np.load(SOURCE/'gte/features.npy')
    for control in json.loads((OUTPUT/'prepared.json').read_text())['controls']:
        ref=joblib.load(OUTPUT/control/'classifier-conservative.joblib');x=cached
        if 'metadata' in ref:
            recipe=ref['metadata'];raw=np.stack([metadata_features(r['text']) for r in rows]);x=np.concatenate([x,recipe['scaler'].transform(raw)*recipe['weight']],axis=1)
        prob=ref['classifier'].predict_proba(x)[:,1];prob[lengths>8192]=1.
        baseline_evaluation[control]={part:metrics(labels[splits[part]],prob[splits[part]],ref['threshold']) for part in ['outer_validation','exploratory_test']}
    atomic_json(OUTPUT/'evaluation.json',{'selected':name,'selectedEvaluation':evaluation,'refittedFrozenControls':baseline_evaluation,
                'testWasAlreadyExaminedInEarlierStudies':True,'testUsedForCheckpointOrDepthSelection':False,'productionEnabled':False})
    emit('direct_final_evaluation_complete',selected=name,evaluation=evaluation)


def run():
    prepare();rows,digest,plan,splits,lengths=context()
    controls=json.loads((OUTPUT/'prepared.json').read_text())['controls']
    references={name:json.loads((OUTPUT/name/'gpu-validation.json').read_text()) for name in controls}
    baseline=min(references.values(),key=score_key);candidates=dict(references)
    logs=OUTPUT/'logs';logs.mkdir(exist_ok=True)
    for layers in plan['depths']:
        for command in ['train','evaluate']:
            stage=f'{command}-l{layers}'
            atomic_json(OUTPUT/'status.json',{'state':'running','stage':stage,'productionEnabled':False})
            emit('direct_stage_start',stage=stage)
            with (logs/f'{stage}.log').open('a') as log:
                child=subprocess.Popen([str(PYTHON),'-u',str(Path(__file__).resolve()),command,'--layers',str(layers)],
                      stdout=log,stderr=subprocess.STDOUT,start_new_session=True,cwd=ROOT)
                try:
                    if child.wait():raise RuntimeError(f'{stage} failed; see {logs/f"{stage}.log"}')
                except BaseException:
                    if child.poll() is None:
                        os.killpg(child.pid,signal.SIGTERM)
                        try:child.wait(timeout=5)
                        except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
                    raise
            emit('direct_stage_complete',stage=stage)
        candidate=json.loads((OUTPUT/f'direct-l{layers}/gpu-validation.json').read_text())
        candidates[candidate['name']]=candidate
        if adequate(candidate,baseline):
            emit('direct_depth_sufficient',layers=layers);break
    selected=min(candidates,key=lambda name:score_key(candidates[name]))
    atomic_json(OUTPUT/'selection.json',{'selectedOnValidation':selected,'baseline':baseline['name'],'candidates':candidates,
                'testUsedForSelection':False,'plan':plan,'selectedBeforeFinalEvaluation':True})
    atomic_json(OUTPUT/'status.json',{'state':'validation_selection_complete','selected':selected,'productionEnabled':False})
    emit('direct_selection_complete',selected=selected)
    with (logs/'final-evaluation.log').open('w') as log:
        subprocess.run([str(PYTHON),'-u',str(Path(__file__).resolve()),'finish'],stdout=log,stderr=subprocess.STDOUT,check=True,cwd=ROOT)
    atomic_json(OUTPUT/'status.json',{'state':'training_and_evaluation_complete','selected':selected,'productionEnabled':False})
    emit('direct_study_complete',selected=selected)


def interrupted(signum,frame):raise KeyboardInterrupt


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('command',choices=['prepare','train','evaluate','finish','run'])
    parser.add_argument('--layers',type=int,choices=[2,6,12],default=2)
    args=parser.parse_args();signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
    try:
        {'prepare':prepare,'train':lambda:train(args.layers),'evaluate':lambda:evaluate(args.layers),'finish':finish,'run':run}[args.command]()
    except BaseException:
        if args.command=='run':
            OUTPUT.mkdir(exist_ok=True,mode=0o700)
            atomic_json(OUTPUT/'status.json',{'state':'failed_or_interrupted','productionEnabled':False})
            subprocess.run(['/usr/bin/afplay','/System/Library/Sounds/Glass.aiff'],check=False)
        raise
