"""Collect completed stages even if training was interrupted or disk-blocked."""
import json
from pathlib import Path

from run import ROOT, atomic_json, load_dataset


def collect(directory):
    _, digest = load_dataset(directory)
    models = {}
    profiles = {}
    for name in ['gte', 'bge', 'gte-setfit']:
        path = directory / name / 'report.json'
        if path.exists():
            report = json.loads(path.read_text())
            if report['datasetSha256'] != digest:
                raise RuntimeError(f'{name} report belongs to another dataset')
            models[name] = report
            profile_path = path.with_name('profile.json')
            if profile_path.exists():
                profile = json.loads(profile_path.read_text())
                if profile['datasetSha256'] != digest or profile['encoder'] != report['encoder']:
                    raise RuntimeError(f'{name} latency profile belongs to another dataset/encoder')
                profiles[name] = profile
    result = {'datasetSha256': digest, 'productionEnabled': False,
              'status': 'experiment_complete' if len(models) == 3 else 'partial_results',
              'models': models, 'profiles': profiles,
              'missingStages': [name for name in ['gte', 'bge', 'gte-setfit'] if name not in models]}
    training_path = directory / 'setfit-training.json'
    if training_path.exists():
        training = json.loads(training_path.read_text())
        if training['datasetSha256'] != digest:
            raise RuntimeError('SetFit training belongs to another dataset')
        result['setfitTraining'] = training
    atomic_json(directory / 'comparison.json', result)
    lines = ['# Offline mail detection results', '',
             'Labels come from historical LLM state, not human ground truth. No production filter is enabled.', '',
             '| Encoder | Validation policy | Useful test threads missed | Useful test recall | LLM calls avoided |',
             '|---|---|---:|---:|---:|']
    for name, report in models.items():
        for policy, data in [('99% recall', report), ('Zero validation misses (exploratory)', report.get('conservativeValidationPolicy'))]:
            if data:
                m = data['test']
                lines.append(f"| {name} | {policy} | {m['falseNegative']}/{m['positiveExamples']} | {m['recallKeep']:.1%} | {m['llmCallsAvoidedFraction']:.1%} |")
    lines.extend(['', 'The thresholds and regularization use validation only. Test has few positive examples; point recall is not a production guarantee.', '',
                  'Missing stages: ' + (', '.join(result['missingStages']) or 'none'), ''])
    if 'setfitTraining' in result:
        training = result['setfitTraining']
        layers = training.get('trainLastLayers', 0)
        scope = f"last {layers} transformer layers" if layers else 'all transformer layers'
        lines.extend([f"SetFit pilot: {training['steps']} contrastive steps, {training['trainingExamples']} training examples, {scope} updated; native context {training['maxSequenceLength']:,} tokens.", ''])
    if profiles:
        lines.extend(['## Local inference latency', '',
                      'Warm median encoder latency on the local evaluation machine. Each cell uses one real thread and three timed runs; other services remain active.', '',
                      '| Encoder | ~128 tokens | ~512 tokens | ~2k tokens | ~4k tokens | ~8k tokens |',
                      '|---|---:|---:|---:|---:|---:|'])
        for name, profile in profiles.items():
            samples = {sample['requestedTokens']: sample for sample in profile['singleRequestWarmLatency']}
            cells = [f"{samples[tokens]['medianSeconds']:.3f} s" if tokens in samples else '—'
                     for tokens in [128, 512, 2048, 4096, 8192]]
            lines.append('| ' + ' | '.join([name, *cells]) + ' |')
        lines.append('')
    (directory / 'comparison.md').write_text('\n'.join(lines))
    print('\n'.join(lines))
    return result


if __name__ == '__main__':
    collect(ROOT / '.local-evals/mail-detection')
