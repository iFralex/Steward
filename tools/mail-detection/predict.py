"""Preview routing for a JSON {text: ...} on stdin; performs no mail actions."""
import argparse
import json
from pathlib import Path
import sys

import joblib
import numpy as np

from run import BGE, GTE, ROOT


def main(args):
    filename = 'classifier-conservative.joblib' if args.policy == 'conservative' else 'classifier.joblib'
    artifact = joblib.load(args.directory / args.name / filename)
    calibration_label={}
    if getattr(args,'calibration','artifact')=='expanded-bank':
        expanded=json.loads((args.directory/'expanded-calibration-backtest.json').read_text())
        if expanded['datasetSha256']!=artifact['datasetSha256']:
            raise RuntimeError('Expanded calibration belongs to another dataset')
        artifact['threshold']=expanded['candidates'][args.name]['threshold']
        calibration_label={'calibrationScope':'expanded-bank-exploratory'}
    if artifact.get('inputKind')=='consensus':
        from scipy import sparse
        from scipy.special import expit,logit
        from metadata import metadata_features
        dense=joblib.load(args.directory/artifact['components'][0]/filename)
        lexical=joblib.load(args.directory/artifact['components'][1]/filename)
        encoder=GTE(dense['encoder'].get('fineTuned'))
        for line in sys.stdin:
            text=json.loads(line)['text'];tokens=encoder.tokens(text)
            if tokens>artifact['maxTokens']:result={'route':'llm','reason':'context_overflow','tokens':tokens}
            else:
                raw=metadata_features(text)[None,:];recipe=dense['metadata']
                features=np.concatenate([encoder.encode([text]),recipe['scaler'].transform(raw)*recipe['weight']],axis=1)
                a=float(dense['classifier'].predict_proba(features)[0,1]);recipe=lexical['metadata']
                features=sparse.hstack([lexical['vectorizer'].transform([text]),sparse.csr_matrix(recipe['scaler'].transform(raw)*recipe['weight'])],format='csr')
                b=float(lexical['classifier'].predict_proba(features)[0,1])
                score=float(expit(max(logit(np.clip(a,1e-12,1-1e-12))-logit(np.clip(dense['threshold'],1e-12,1-1e-12)),
                    logit(np.clip(b,1e-12,1-1e-12))-logit(np.clip(lexical['threshold'],1e-12,1-1e-12)))))
                result={'route':'llm' if score>=artifact['threshold'] else 'discard_candidate','score':score,'threshold':artifact['threshold'],'tokens':tokens,'calibratedProbability':False}
            print(json.dumps({**result,**calibration_label,'previewOnly':True}),flush=True)
        return
    if artifact.get('inputKind')=='text-tfidf-metadata':
        from transformers import AutoTokenizer
        from scipy import sparse
        from metadata import metadata_features
        from run import CACHE,REVISION
        tokenizer=AutoTokenizer.from_pretrained(str(CACHE/f'models--Alibaba-NLP--gte-multilingual-base/snapshots/{REVISION}'),local_files_only=True)
        for line in sys.stdin:
            text=json.loads(line)['text'];tokens=len(tokenizer(text,truncation=False)['input_ids'])
            if tokens>artifact['maxTokens']:result={'route':'llm','reason':'context_overflow','tokens':tokens}
            else:
                recipe=artifact['metadata'];extra=recipe['scaler'].transform(metadata_features(text)[None,:])*recipe['weight']
                x=sparse.hstack([artifact['vectorizer'].transform([text]),sparse.csr_matrix(extra)],format='csr')
                score=float(artifact['classifier'].predict_proba(x)[0,1])
                result={'route':'llm' if score>=artifact['threshold'] else 'discard_candidate','score':score,'threshold':artifact['threshold'],'tokens':tokens}
            print(json.dumps({**result,**calibration_label,'previewOnly':True}),flush=True)
        return
    tuned = artifact['encoder'].get('fineTuned')
    if tuned and not Path(tuned).is_absolute():
        tuned = ROOT / tuned
    base_name = args.name.removesuffix('-meta')
    encoder = (BGE if base_name == 'bge' else GTE)(tuned)
    expected = artifact['encoder']
    if base_name == 'bge' and expected['digest'] != encoder.provenance['digest']:
        raise RuntimeError('Ollama model digest differs from the evaluated classifier.')
    if tuned and expected['fineTunedWeightsSha256'] != encoder.provenance['fineTunedWeightsSha256']:
        raise RuntimeError('Fine-tuned weights differ from the evaluated classifier.')
    for line in sys.stdin:
        data = json.loads(line)
        text = data['text']
        tokens = encoder.tokens(text)
        if tokens > artifact['maxTokens']:
            result = {'route': 'llm', 'reason': 'context_overflow', 'tokens': tokens}
        else:
            features = encoder.encode([text])
            if 'metadata' in artifact:
                from metadata import FEATURE_NAMES, metadata_features
                recipe = artifact['metadata']
                if recipe['version'] != 1 or recipe['featureNames'] != FEATURE_NAMES:
                    raise RuntimeError('Metadata feature recipe differs from the evaluated classifier')
                extra = recipe['scaler'].transform(metadata_features(text)[None, :]) * recipe['weight']
                features = np.concatenate([features, extra], axis=1)
            score = float(artifact['classifier'].predict_proba(features)[0, 1])
            result = {'route': 'llm' if score >= artifact['threshold'] else 'discard_candidate',
                      'score': score, 'threshold': artifact['threshold'], 'tokens': tokens}
        print(json.dumps({**result, **calibration_label, 'previewOnly': True}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=ROOT / '.local-evals/mail-detection')
    parser.add_argument('--name', choices=['gte', 'bge', 'gte-setfit', 'gte-meta', 'bge-meta', 'gte-setfit-meta',
                        'direct-frozen','direct-frozen-meta','direct-frozen-c1','direct-l2','direct-l6','direct-l12',
                        'base-head','base-meta','tuned-head','tuned-meta','tuned-joint-head','sparse-text-meta','consensus'], required=True)
    parser.add_argument('--policy', choices=['primary', 'conservative'], default='conservative')
    parser.add_argument('--calibration',choices=['artifact','expanded-bank'],default='artifact')
    main(parser.parse_args())
