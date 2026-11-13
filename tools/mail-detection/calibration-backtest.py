"""Secondary exploratory threshold backtest; never changes primary selection."""
import hashlib
import json

import numpy as np

from followup import OUT,setup
from run import atomic_json,metrics


def main():
    rows,digest,plan,splits,lengths=setup()
    selection_path=OUT/'selection.json';primary_hash=hashlib.sha256(selection_path.read_bytes()).hexdigest()
    selection=json.loads(selection_path.read_text())
    protocol={'postHocExploratory':True,'reason':'high-recall curve improvement versus unstable small calibration bank',
        'bank':['calibration','selection'],'thresholdRule':'minimum positive score in bank',
        'allCandidatesIncluded':list(selection['candidates']),'headTrainingChanged':False,
        'primarySelectionChanged':False,'independentEvidence':False,
        'finalFoldLabelsUsedToChooseThreshold':False,'noNewDeployableModel':True}
    path=OUT/'expanded-calibration-protocol.json'
    if path.exists():assert json.loads(path.read_text())==protocol
    else:atomic_json(path,protocol)
    labels=np.asarray([r['label'] for r in rows]);bank=np.asarray(splits['calibration']+splits['selection'])
    candidates={}
    for name,original in selection['candidates'].items():
        scores=np.load(OUT/f'{name}-scores.npy');threshold=float(scores[bank[labels[bank]==1]].min())
        measured={part:metrics(labels[splits[part]],scores[splits[part]],threshold)
                  for part in ['outer_validation','exploratory_test']}
        calibration=metrics(labels[bank],scores[bank],threshold);assert calibration['falseNegative']==0
        candidates[name]={'threshold':threshold,'originalThreshold':original['threshold'],
            'bank':calibration,'exploratoryEvaluation':measured}
    assert hashlib.sha256(selection_path.read_bytes()).hexdigest()==primary_hash
    atomic_json(OUT/'expanded-calibration-backtest.json',{'protocol':protocol,'datasetSha256':digest,
        'primarySelectionSha256Unchanged':primary_hash,'bankExamples':len(bank),
        'bankPositiveExamples':int(labels[bank].sum()),'candidates':candidates,'productionEnabled':False})
    for name,c in candidates.items():
        print(name,{part:{'missed':m['falseNegative'],'discard':m['llmCallsAvoidedFraction']}
            for part,m in c['exploratoryEvaluation'].items()})


if __name__=='__main__':main()
