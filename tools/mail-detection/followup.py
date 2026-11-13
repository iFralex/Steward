"""Replay the useful encoder, refit heads fairly, and compare high-recall routing.

All historical folds are exploratory. This script never calls a paid model,
changes mail, or sends private data outside this Mac.
"""
import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.feature_extraction.text import TfidfVectorizer
from scipy import sparse
from scipy.special import expit,logit

import direct as d
from direct_model import DirectHead
from metadata import FEATURE_NAMES, metadata_features
from run import GTE, atomic_json, metrics

OUT=d.ROOT/'.local-evals/mail-detection-followup'


def setup():
    OUT.mkdir(exist_ok=True,mode=0o700);os.chmod(OUT,0o700)
    rows,digest,plan,splits,lengths=d.context()
    recipe={'sourceDatasetSha256':digest,'sourceStudy':str(d.OUTPUT),'seed':d.SEED,
        'encoderCheckpoint':{'layers':12,'examples':256,'scheduleLengthForLearningRates':1024},
        'headCGrid':[.1,1.,10.,100.],'metadataWeights':[0.,.01,.03,.1,.3,1.],
        'fitFold':'optimization only','headHyperparametersAndThreshold':'calibration only',
        'selection':'selection, previously inspected; exploratory',
        'finalFolds':'outer_validation and exploratory_test, both previously inspected',
        'matchedRecallCurves':'oracle diagnostic thresholds on each fold, never deployment thresholds',
        'targets':[.99,1.0],'productionEnabled':False,'paidLlmCalls':0}
    path=OUT/'plan.json'
    if path.exists():assert json.loads(path.read_text())==recipe
    else:atomic_json(path,recipe)
    extension={'lexicalControl':{'features':'TF-IDF word1/2grams','maxFeatures':20000,'minDf':2,
        'metadataWeights':[0.,.01,.1,1.],'fit':'optimization only'},
        'embeddingResourceLifetime':'fresh MPS process for each padding bucket',
        'calibrationDiagnostics':'eligible rows only; exclude routing-overridden overflow probabilities',
        'review':'blind packet plus separate weak-label/debug packet; no automatic relabeling'}
    path=OUT/'plan-extensions.json'
    if path.exists():assert json.loads(path.read_text())==extension
    else:atomic_json(path,extension)
    return rows,digest,plan,splits,lengths


def replay():
    import torch
    from transformers import AutoModel,AutoTokenizer
    from transformers.optimization import Adafactor
    rows,digest,plan,splits,lengths=setup()
    target=OUT/'checkpoint256';target.mkdir(exist_ok=True)
    if (target/'done.json').exists():
        assert json.loads((target/'done.json').read_text())['datasetSha256']==digest
        d.emit('followup_checkpoint_cached');return
    d.guard();torch.set_num_threads(4);torch.manual_seed(d.SEED)
    base=str(d.CACHE/f'models--Alibaba-NLP--gte-multilingual-base/snapshots/{d.REVISION}')
    tokenizer=AutoTokenizer.from_pretrained(base,local_files_only=True)
    model=AutoModel.from_pretrained(base,trust_remote_code=True,code_revision=d.CODE_REVISION,
        cache_dir=str(d.CACHE),local_files_only=True,attn_implementation='sdpa',torch_dtype=torch.float32).cpu()
    model.requires_grad_(False);vocabulary=d.compact_frozen_vocabulary(model,torch)
    for layer in model.encoder.layer:layer.requires_grad_(True)
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant':False})
    initial=joblib.load(d.OUTPUT/'initial-head.joblib');head=torch.nn.Linear(768,1)
    with torch.no_grad():
        head.weight.copy_(torch.from_numpy(initial.coef_.astype(np.float32)))
        head.bias.copy_(torch.from_numpy(initial.intercept_.astype(np.float32)))
    groups=[]
    for index,layer in enumerate(model.encoder.layer):
        for decay in [False,True]:
            parameters=[p for name,p in layer.named_parameters() if p.requires_grad and (p.ndim>1)==decay]
            groups.append({'params':parameters,'lr':plan['encoderTopLearningRate']*plan['layerLearningRateDecay']**(11-index),
                'weight_decay':.01 if decay else 0.})
    groups.append({'params':list(head.parameters()),'lr':plan['headLearningRate'],'weight_decay':0.})
    optimizer=Adafactor(groups,relative_step=False,scale_parameter=False,warmup_init=False)
    learning_rates=[g['lr'] for g in groups]
    schedule=json.loads((d.OUTPUT/'training-schedule.json').read_text())
    assert len(schedule)==1024 and len(set(schedule))==1024 and set(schedule)<=set(splits['optimization'])
    reference={}
    for line in (d.OUTPUT/'logs/train-l12.log').read_text().splitlines():
        if not line.startswith('{'):continue
        event=json.loads(line)
        if event['event']=='direct_train_start':reference={}
        elif event['event']=='direct_training':reference[event['examplesSeen']]=event
    total_updates=len(schedule)//4;warmup=max(1,round(total_updates*.1));losses=[];trajectory=[]
    model.train();head.train();optimizer.zero_grad(set_to_none=True);started=time.perf_counter()
    for step in range(64):
        d.guard();ratio=min(1.,(step+1)/warmup) if step<warmup else max(0.,(total_updates-step)/(total_updates-warmup))
        for group,lr in zip(optimizer.param_groups,learning_rates):group['lr']=lr*ratio
        for i in schedule[step*4:(step+1)*4]:
            encoded=tokenizer(rows[i]['text'],truncation=False,return_tensors='pt')
            assert encoded['input_ids'].shape[1]==lengths[i] and lengths[i]<=8192
            vector=torch.nn.functional.normalize(model(**encoded).last_hidden_state[:,0].float(),dim=-1)
            loss=torch.nn.functional.binary_cross_entropy_with_logits(head(vector).reshape(1),torch.tensor([float(rows[i]['label'])]))
            assert torch.isfinite(loss)
            (loss/4).backward();losses.append(float(loss.detach()))
        norm=torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad]+list(head.parameters()),1.)
        assert torch.isfinite(norm);optimizer.step();optimizer.zero_grad(set_to_none=True)
        seen=(step+1)*4
        if seen%16==0:
            observed={'examplesSeen':seen,'loss':float(np.mean(losses[-16:])),'gradientNorm':float(norm)}
            difference=max(abs(observed[k]-reference[seen][k]) for k in ['loss','gradientNorm'])
            assert difference<1e-6, 'Replay differs from the original optimization trajectory'
            trajectory.append({**observed,'maximumReferenceDelta':difference})
            d.emit('followup_replay',**trajectory[-1])
    del optimizer;gc.collect()
    d.save_best(model,head,target,12,256,{'notEvaluated':True,'purpose':'encoder replay for independent head refitting'},torch)
    atomic_json(target/'done.json',{'datasetSha256':digest,'examplesSeen':256,'uniqueLossExamples':256,
        'schedulePreserved':True,'lossOptimizationOnly':True,'trajectory':trajectory,'seconds':time.perf_counter()-started,
        'frozenVocabulary':vocabulary,'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
    d.emit('followup_replay_complete')


def embed_bucket(bucket):
    rows,digest,plan,splits,lengths=setup();folder=OUT/'tuned';folder.mkdir(exist_ok=True)
    buckets=np.minimum(8192,np.maximum(128,2**np.ceil(np.log2(np.maximum(lengths,1))).astype(int)))
    path=folder/'features.npy'
    vectors=np.lib.format.open_memmap(path,mode='r+' if path.exists() else 'w+',dtype=np.float32,shape=(len(rows),768))
    norms=np.linalg.norm(vectors,axis=1)
    pending=sorted([int(i) for i in np.flatnonzero((lengths<=8192)&(buckets==bucket)) if not (.99<norms[i]<1.01)],key=lambda i:lengths[i])
    if not pending:d.emit('followup_embedding_bucket_cached',bucket=bucket);return
    encoder=GTE(OUT/'checkpoint256/encoder')
    identity={'datasetSha256':digest,'encoder':encoder.provenance,'maxTokens':8192}
    manifest=folder/'manifest.json'
    if manifest.exists():assert json.loads(manifest.read_text())==identity
    else:atomic_json(manifest,identity)
    batch_size=4 if bucket<=2048 else (2 if bucket<=4096 else 1)
    for position in range(0,len(pending),batch_size):
        batch=pending[position:position+batch_size];d.guard();v=encoder.encode([rows[i]['text'] for i in batch])
        norms=np.linalg.norm(v,axis=1)
        assert np.isfinite(v).all() and np.all((norms>.99)&(norms<1.01))
        vectors[batch]=v;vectors.flush();finished=position+len(batch)
        if finished%100<len(batch) or finished==len(pending):d.emit('followup_embedding',bucket=bucket,done=finished,total=len(pending))


def embed():
    # A fresh GPU process per padding bucket releases compiled MPS graph caches.
    # Inputs and FP16 weights are identical; only resource lifetime changes.
    rows,digest,plan,splits,lengths=setup()
    for bucket in [128,256,512,1024,2048,4096,8192]:
        subprocess.run([sys.executable,'-u',str(Path(__file__).resolve()),'embed-bucket','--bucket',str(bucket)],check=True)
    folder=OUT/'tuned';identity=json.loads((folder/'manifest.json').read_text())
    assert identity['datasetSha256']==digest
    with (OUT/'checkpoint256/encoder/adapter.safetensors').open('rb') as f:
        assert hashlib.file_digest(f,'sha256').hexdigest()==identity['encoder']['fineTunedWeightsSha256']
    norms=np.linalg.norm(np.load(folder/'features.npy'),axis=1)
    assert np.all((norms[lengths<=8192]>.99)&(norms[lengths<=8192]<1.01))
    atomic_json(folder/'done.json',identity)


def diagnostic_curve(labels,scores,targets):
    result=[];positive=np.sort(scores[labels==1])
    for target in targets:
        allowed=int(np.floor((1-target)*len(positive)+1e-9))
        threshold=float(positive[allowed]);m=metrics(labels,scores,threshold)
        result.append({'requestedRecall':target,'oracleThreshold':threshold,'metrics':m,'diagnosticOnly':True})
    return result


def full_curve(labels,scores):
    thresholds=np.unique(np.r_[0.,scores,1.]);order=np.argsort(scores)
    positives=np.r_[0,np.cumsum(labels[order])];negatives=np.arange(len(scores)+1)-positives
    positions=np.searchsorted(scores[order],thresholds,side='left')
    return {'thresholds':thresholds.tolist(),'falseNegatives':positives[positions].tolist(),
        'trueNegatives':negatives[positions].tolist(),'examples':len(scores),'positiveExamples':int(labels.sum()),
        'diagnosticOnly':True,'overflowAlwaysForwardedAtThresholdAtMostOne':True}


def fit():
    rows,digest,plan,splits,lengths=setup();labels=np.asarray([r['label'] for r in rows])
    train=np.asarray([i for i in splits['optimization'] if lengths[i]<=8192])
    raw=np.stack([metadata_features(r['text']) for r in rows]);scaler=StandardScaler().fit(raw[train]);extra=scaler.transform(raw)
    recipe=json.loads((OUT/'plan.json').read_text());candidates={};scores_by_name={}
    for encoder_name,features,provenance in [
        ('base',np.load(d.SOURCE/'gte/features.npy'),json.loads((d.SOURCE/'gte/manifest.json').read_text())['encoder']),
        ('tuned',np.load(OUT/'tuned/features.npy'),json.loads((OUT/'tuned/manifest.json').read_text())['encoder'])]:
        for metadata in [False,True]:
            name=encoder_name+('-meta' if metadata else '-head');variants=[]
            for weight in recipe['metadataWeights'] if metadata else [0.]:
                x=np.concatenate([features,extra*weight],axis=1) if metadata else features
                for c in recipe['headCGrid']:
                    classifier=LogisticRegression(C=c,max_iter=2000,random_state=d.SEED).fit(x[train],labels[train])
                    scores=classifier.predict_proba(x)[:,1];scores[lengths>8192]=1.
                    measure=d.measured(rows,scores,splits)
                    variants.append((measure['calibration']['trueNegative'],-c,-weight,classifier,scores,measure,weight))
            _,_,_,classifier,scores,measure,weight=max(variants,key=lambda v:v[:3])
            folder=OUT/name;folder.mkdir(exist_ok=True)
            artifact={'classifier':classifier,'threshold':measure['threshold'],'encoder':provenance,'maxTokens':8192,'datasetSha256':digest}
            if metadata:artifact['metadata']={'version':1,'featureNames':FEATURE_NAMES,'scaler':scaler,'weight':weight}
            joblib.dump(artifact,folder/'classifier-conservative.joblib')
            candidates[name]={**measure,'encoder':provenance,'C':classifier.C,'metadataWeight':weight}
            scores_by_name[name]=scores
    # Original jointly trained head is an explicit control, without metadata.
    values=np.load(OUT/'checkpoint256/head.npz');original=DirectHead(values['weight'],values['bias'])
    original_scores=original.predict_proba(np.load(OUT/'tuned/features.npy'))[:,1];original_scores[lengths>8192]=1.
    scores_by_name['tuned-joint-head']=original_scores
    candidates['tuned-joint-head']=d.measured(rows,original_scores,splits)
    folder=OUT/'tuned-joint-head';folder.mkdir(exist_ok=True)
    joblib.dump({'classifier':original,'threshold':candidates['tuned-joint-head']['threshold'],
        'encoder':json.loads((OUT/'tuned/manifest.json').read_text())['encoder'],'maxTokens':8192,
        'datasetSha256':digest},folder/'classifier-conservative.joblib')
    # A genuinely different, cheap lexical control. Vocabulary and IDF fit only
    # optimization; no encoder, no context truncation, same overflow routing.
    vectorizer=TfidfVectorizer(max_features=20000,min_df=2,max_df=.98,ngram_range=(1,2),sublinear_tf=True)
    vectorizer.fit([rows[i]['text'] for i in train]);lexical=vectorizer.transform([r['text'] for r in rows])
    variants=[]
    for weight in [0.,.01,.1,1.]:
        x=sparse.hstack([lexical,sparse.csr_matrix(extra*weight)],format='csr')
        for c in recipe['headCGrid']:
            classifier=LogisticRegression(C=c,max_iter=2000,random_state=d.SEED).fit(x[train],labels[train])
            scores=classifier.predict_proba(x)[:,1];scores[lengths>8192]=1.;measure=d.measured(rows,scores,splits)
            variants.append((measure['calibration']['trueNegative'],-c,-weight,classifier,scores,measure,weight))
    _,_,_,classifier,scores,measure,weight=max(variants,key=lambda v:v[:3])
    name='sparse-text-meta';folder=OUT/name;folder.mkdir(exist_ok=True)
    joblib.dump({'inputKind':'text-tfidf-metadata','vectorizer':vectorizer,'classifier':classifier,
        'metadata':{'version':1,'featureNames':FEATURE_NAMES,'scaler':scaler,'weight':weight},
        'threshold':measure['threshold'],'datasetSha256':digest,'maxTokens':8192},folder/'classifier-conservative.joblib')
    candidates[name]={**measure,'C':classifier.C,'metadataWeight':weight,'paradigm':'TF-IDF words+bigrams and logistic head, no encoder'}
    scores_by_name[name]=scores
    consensus_recipe={'components':['base-meta','sparse-text-meta'],'route':'keep if either component keeps',
        'threshold':.5,'score':'sigmoid(max(component logit minus calibrated-threshold logit))',
        'calibratedProbability':False,'chosenWithoutFinalFoldResults':True}
    path=OUT/'plan-consensus.json'
    if path.exists():assert json.loads(path.read_text())==consensus_recipe
    else:atomic_json(path,consensus_recipe)
    margins=[logit(np.clip(scores_by_name[n],1e-12,1-1e-12))-logit(np.clip(candidates[n]['threshold'],1e-12,1-1e-12))
             for n in consensus_recipe['components']]
    scores=expit(np.maximum(*margins));scores[lengths>8192]=1.
    measure=d.measured(rows,scores,splits);measure['threshold']=.5
    assert np.array_equal(scores>=.5,(scores_by_name['base-meta']>=candidates['base-meta']['threshold'])|
        (scores_by_name['sparse-text-meta']>=candidates['sparse-text-meta']['threshold']))
    for part in ['calibration','selection']:measure[part]=metrics(labels[splits[part]],scores[splits[part]],.5)
    name='consensus';folder=OUT/name;folder.mkdir(exist_ok=True)
    joblib.dump({'inputKind':'consensus','components':consensus_recipe['components'],'threshold':.5,
        'datasetSha256':digest,'maxTokens':8192,'calibratedProbability':False},folder/'classifier-conservative.joblib')
    scores_by_name[name]=scores;candidates[name]={**measure,'paradigm':consensus_recipe['route'],'calibratedProbability':False}
    for name in candidates:
        alias=OUT/name/'classifier.joblib'
        if not alias.exists():alias.symlink_to('classifier-conservative.joblib')
    selected=min(candidates,key=lambda name:d.score_key(candidates[name]))
    atomic_json(OUT/'selection.json',{'selected':selected,'candidates':candidates,'finalFoldsUsed':False,
        'allFoldsPreviouslyInspected':True,'productionEnabled':False})
    curves={};final={};points={};calibration={}
    for name,scores in scores_by_name.items():
        np.save(OUT/f'{name}-scores.npy',scores)
        curves[name]={part:diagnostic_curve(labels[splits[part]],scores[splits[part]],recipe['targets']) for part in splits if part!='optimization'}
        points[name]={part:full_curve(labels[splits[part]],scores[splits[part]]) for part in splits if part!='optimization'}
        final[name]={part:metrics(labels[splits[part]],scores[splits[part]],candidates[name]['threshold'])
                     for part in ['outer_validation','exploratory_test']}
        calibration[name]={}
        if name=='consensus':
            calibration[name]={'notACalibratedProbability':True,'diagnosticsOmitted':True}
            continue
        for part in ['calibration','selection','outer_validation','exploratory_test']:
            ids=[i for i in splits[part] if lengths[i]<=8192];y=labels[ids];p=scores[ids];ece=0.
            for j in range(10):
                mask=(p>=j/10)&((p<(j+1)/10) if j<9 else (p<=1))
                if mask.any():ece+=mask.mean()*abs(p[mask].mean()-y[mask].mean())
            calibration[name][part]={'eligibleExamples':len(ids),'brier':float(np.mean((p-y)**2)),
                'ece10EqualWidth':float(ece),'weakLabelsOnly':True,'overflowExcluded':True}
    atomic_json(OUT/'evaluation.json',{'selected':selected,'final':final,'matchedRecallOracleDiagnostics':curves,
        'calibrationDiagnostics':calibration,'selectionFixedBeforeFinalEvaluation':True,
        'allResultsExploratory':True,'paidLlmCalls':0,'productionEnabled':False})
    atomic_json(OUT/'curve-points.json',points)
    review(rows,labels,splits,scores_by_name,candidates)
    d.emit('followup_heads_complete',selected=selected)


def review(rows,labels,splits,scores,candidates):
    # JSON permits Unicode line separators inside strings. Iterate LF-delimited
    # records rather than str.splitlines(), which would split those characters.
    for filename in ['human-review.jsonl','human-review-blind.jsonl','human-review-priority20.jsonl']:
        path=OUT/filename
        if path.exists():
            existing=[json.loads(line) for line in path.open() if line.strip()]
            if any(r.get('humanLabel') is not None or r.get('humanReason') for r in existing):
                raise RuntimeError('Human review annotations exist; preserve them before regenerating the packet.')
    base=scores['base-meta'];threshold=candidates['base-meta']['threshold']
    anchors=[]
    for name in candidates:
        for bank in [splits['calibration'],splits['calibration']+splits['selection']]:
            positive=[i for i in bank if labels[i]==1]
            anchors.append(min(positive,key=lambda i:scores[name][i]))
    anchors=list(dict.fromkeys(anchors))
    errors=[i for part in ['selection','outer_validation','exploratory_test'] for i in splits[part]
        if labels[i]==1 and any(scores[name][i]<candidates[name]['threshold'] for name in candidates)]
    disagreements=[i for i in splits['optimization'] if (scores['tuned-meta'][i]>=candidates['tuned-meta']['threshold'])!=(base[i]>=threshold)]
    uncertain=sorted(splits['optimization'],key=lambda i:abs(base[i]-threshold))
    ids=list(dict.fromkeys(anchors+errors+disagreements[:60]+uncertain[:100]))[:120]
    with (OUT/'human-review.jsonl').open('w') as stream:
        os.chmod(stream.name,0o600)
        for i in ids:
            item={'rowIndex':i,'threadId':rows[i]['threadId'],'sourceFold':rows[i]['split'],
                'reason':('calibration_positive_threshold_anchor' if i in anchors else
                    'known_historical_false_negative' if i in errors else 'training_disagreement_or_uncertainty'),
                'historicalWeakLabel':int(labels[i]),'humanLabel':None,'humanReason':None,'text':rows[i]['text']}
            stream.write(json.dumps(item,ensure_ascii=False)+'\n')
    atomic_json(OUT/'human-review-summary.json',{'examples':len(ids),'knownFalseNegatives':len(errors),'thresholdAnchors':len(anchors),
        'humanLabelsProvided':0,'notAnIndependentTest':True,'noLabelsChanged':True})
    with (OUT/'human-review-blind.jsonl').open('w') as stream:
        os.chmod(stream.name,0o600)
        for i in ids:stream.write(json.dumps({'rowIndex':i,'threadId':rows[i]['threadId'],
            'text':rows[i]['text'],'humanLabel':None,'humanReason':None},ensure_ascii=False)+'\n')
    with (OUT/'human-review-blind.jsonl').open() as stream:blind=list(stream)
    with (OUT/'human-review-priority20.jsonl').open('w') as stream:stream.writelines(blind[:20])
    os.chmod(OUT/'human-review-priority20.jsonl',0o600)


def run():
    setup();logs=OUT/'logs';logs.mkdir(exist_ok=True)
    for command in ['replay','embed','fit']:
        atomic_json(OUT/'status.json',{'state':'running','stage':command,'productionEnabled':False})
        with (logs/f'{command}.log').open('a') as log:
            subprocess.run([sys.executable,'-u',str(Path(__file__).resolve()),command],stdout=log,stderr=subprocess.STDOUT,check=True)
    atomic_json(OUT/'status.json',{'state':'numerical_comparison_complete','productionEnabled':False})


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['run','replay','embed','embed-bucket','fit']);parser.add_argument('--bucket',type=int);args=parser.parse_args()
    try:
        if args.command=='embed-bucket':embed_bucket(args.bucket)
        else:globals()[args.command]()
    except BaseException:
        if OUT.exists():atomic_json(OUT/'status.json',{'state':'failed_or_interrupted','productionEnabled':False})
        subprocess.run(['/usr/bin/afplay','/System/Library/Sounds/Glass.aiff'],check=False)
        raise
