"""Freeze the explicitly authorized tuned-head/expanded-bank gate for production."""
import argparse
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import shutil
import joblib
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--policy-hash',required=True)
    args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=True,mode=0o700)
    if (output/'activation.json').exists():raise RuntimeError('Do not overwrite an activated release')
    assert len(args.policy_hash)==64 and int(args.policy_hash,16)>=0
    folder=ROOT/'.local-evals/mail-detection-followup'
    artifact=joblib.load(folder/'tuned-head/classifier-conservative.joblib')
    expanded=json.loads((folder/'expanded-calibration-backtest.json').read_text())
    assert artifact['datasetSha256']==expanded['datasetSha256']
    classifier=artifact['classifier'];assert np.array_equal(classifier.classes_,[0,1])
    encoder=artifact['encoder'];source=Path(encoder['fineTuned']);adapter=output/'encoder';adapter.mkdir(exist_ok=True)
    assert sha(source/'adapter.safetensors')==encoder['fineTunedWeightsSha256']
    for name in ['adapter.safetensors','adapter_config.json']:
        target=adapter/name
        if target.exists(): assert sha(target)==sha(source/name)
        else: shutil.copyfile(source/name,target)
    shutil.copyfile(ROOT/'apps/mail-promoter/python/gte_worker.py',output/'gte_worker.py')
    base=ROOT/'.local-models/hub/models--Alibaba-NLP--gte-multilingual-base/snapshots'/encoder['revision']
    modules=ROOT/'.local-models/modules'
    files={str(path):sha(path) for path in base.rglob('*') if path.is_file()}
    for path in (modules/'transformers_modules/Alibaba-NLP/new-impl'/encoder['codeRevision']).glob('*.py'):files[str(path)]=sha(path)
    for path in (ROOT/'.local-models/hub/models--Alibaba-NLP--new-impl/snapshots'/encoder['codeRevision']).glob('*.py'):files[str(path)]=sha(path)
    for path in [adapter/'adapter.safetensors',adapter/'adapter_config.json',output/'gte_worker.py']:files[str(path)]=sha(path)
    coef=classifier.coef_[0];intercept=float(classifier.intercept_[0])
    calibrated_threshold=float(expanded['candidates']['tuned-head']['threshold'])
    # Keep boundary positives despite last-bit sigmoid/BLAS differences.
    threshold=calibrated_threshold-1e-6
    reference=np.load(folder/'tuned-head-scores.npy')
    assert np.array_equal(reference>=threshold,reference>=calibrated_threshold)
    # Verify JSON parameter inference against sklearn, including saturated logits.
    probe=np.random.default_rng(42).normal(size=(128,768));logits=probe@coef+intercept
    predicted=np.where(logits>=0,1/(1+np.exp(-np.maximum(logits,-700))),np.exp(np.minimum(logits,700))/(1+np.exp(np.minimum(logits,700))))
    assert np.max(np.abs(predicted-classifier.predict_proba(probe)[:,1]))<1e-12
    manifest={'schemaVersion':1,'inputVersion':1,'model':'gte-multilingual-base/tuned-head',
        'basePath':str(base),'baseRevision':encoder['revision'],'codeRevision':encoder['codeRevision'],
        'adapterConfig':str(adapter/'adapter_config.json'),'adapterWeights':str(adapter/'adapter.safetensors'),
        'modulesCache':str(modules),'files':files,'policyHash':args.policy_hash,'maxTokens':8192,
        'threshold':threshold,'calibratedThreshold':calibrated_threshold,'numericSafetyMargin':1e-6,
        'classifier':{'coef':coef.tolist(),'intercept':intercept},'datasetSha256':artifact['datasetSha256'],
        'calibration':'expanded-bank-exploratory','positiveBankExamples':expanded['bankPositiveExamples'],
        'humanGroundTruth':False,'productionAuthorization':'User explicitly requested GTE in production',
        'runtimeVersions':{name:version(name) for name in ['torch','transformers','numpy','safetensors']}}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({'manifest':str(output/'manifest.json'),'modelId':sha(output/'manifest.json'),'threshold':manifest['threshold']}))


if __name__=='__main__':main()
