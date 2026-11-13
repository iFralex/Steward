"""One fresh MPS process per length: avoid retaining multiple large graphs."""
import argparse
import time

import joblib
import numpy as np

from followup import OUT,setup
from metadata import metadata_features
from run import GTE,atomic_json


def main(budget):
    rows,digest,plan,splits,lengths=setup();name='tuned-head'
    artifact=joblib.load(OUT/name/'classifier-conservative.joblib')
    encoder=GTE(artifact['encoder']['fineTuned'])
    assert encoder.provenance==artifact['encoder']
    i=int(max(np.flatnonzero(lengths<=budget),key=lambda i:lengths[i]));times=[]
    for _ in range(4):
        started=time.perf_counter();tokens=encoder.tokens(rows[i]['text']);assert tokens<=8192
        features=encoder.encode([rows[i]['text']])
        score=artifact['classifier'].predict_proba(features)[0,1];bool(score>=artifact['threshold'])
        times.append(time.perf_counter()-started)
    result={'name':name,'requestedTokens':budget,'actualTokens':int(lengths[i]),
        'medianSeconds':float(np.median(times[1:])),'maximumSeconds':max(times[1:]),
        'encoder':encoder.provenance,'memory':encoder.memory(),
        'includes':'tokenization, encoder, head, comparison; no LLM forwarding',
        'sample':'one real thread, one warmup and three timed runs; other services may be active'}
    atomic_json(OUT/f'profile-tuned-head-{budget}.json',result);print(result)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--budget',type=int,choices=[512,4096,8192],required=True)
    main(parser.parse_args().budget)
