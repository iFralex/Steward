"""Audited weak labels and a new, period-stratified, template-disjoint holdout.

Uses readonly local sources only. Pipe export through prepare-thread.mjs to finish.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import random
import re
import sys

from prepare import readonly


def export(home=None):
    home = home or Path.home() / 'Library/Application Support'
    audit = readonly(home / 'steward-audit/audit.db')
    proofs = collections.defaultdict(list)
    verdicts = {}
    for row in audit.execute("SELECT id,ts,event_type,payload_json FROM audit_events WHERE event_type IN ('wiki.promoted','mail.triage_decided') ORDER BY id"):
        payload = json.loads(row['payload_json'])
        if row['event_type'] == 'wiki.promoted':
            match = re.fullmatch(r'mail-thread-(\d+)\.md', payload.get('filename', ''))
            if match:
                proofs[int(match[1])].append((row['ts'] // 1000, row['id']))
        elif (payload.get('schemaVersion') == 1
              and all(isinstance(payload.get(k), bool) for k in ['promote', 'promoteMail', 'promoteAttachments'])
              and payload['promote'] == (payload['promoteMail'] or payload['promoteAttachments'])):
            verdicts[payload['threadId']] = (row['ts'] // 1000, row['id'], payload)
    audit.close()
    state = readonly(home / 'mail-promoter/state.db')
    labels = {}
    seen_state = set()
    exclusions = collections.Counter()
    for raw in state.execute("SELECT * FROM promote_state WHERE decision IN ('promoted','skipped') AND message_id LIKE 'thread:%'"):
        row = dict(raw)
        tid = int(row['message_id'].split(':')[1])
        seen_state.add(tid)
        explicit = verdicts.get(tid)
        matching = [(ts, eid) for ts, eid in proofs.get(tid, []) if row['promoted_at'] in (ts, ts + 1)]
        if explicit and explicit[0] >= row['promoted_at'] - 1:
            ts, eid, payload = explicit
            evidence = {'kind': 'explicit_triage_audit', 'auditEventId': eid,
                        'promoteMail': payload['promoteMail'], 'promoteAttachments': payload['promoteAttachments'],
                        'promote': payload['promote'], 'attachmentInputHash': payload['attachmentInputHash'],
                        'policyHash': payload['policyHash']}
            row['promoted_at'] = ts
            row['source_hash'] = payload['sourceHash']
            row['classify_model'] = payload['model']
        elif row['decision'] == 'skipped':
            evidence = {'kind': 'negative_terminal_state', 'promoteMail': False,
                        'promoteAttachments': False, 'promote': False}
        elif matching:
            evidence = {'kind': 'wiki_audit_same_decision_second', 'auditEventId': matching[-1][1],
                        'promoteMail': True, 'promoteAttachments': None, 'promote': True}
        else:
            # Never turn a retained note or an unverified attachment state into
            # a current positive verdict.
            exclusions['ambiguous_historical_positive'] += 1
            continue
        row['labelEvidence'] = evidence
        labels[tid] = row
    state.close()
    for tid, (ts, eid, payload) in verdicts.items():
        if tid not in seen_state:
            # A valid verdict survives even if its downstream wiki write failed
            # and no terminal promotion state exists. Node verifies the current
            # content and attachment snapshot before this becomes an example.
            labels[tid] = {'message_id': f'thread:{tid}', 'decision': 'promoted' if payload['promote'] else 'skipped',
                'source_hash': payload['sourceHash'], 'promoted_at': ts, 'classify_model': payload['model'],
                'labelEvidence': {'kind': 'explicit_triage_audit', 'auditEventId': eid,
                    'promoteMail': payload['promoteMail'], 'promoteAttachments': payload['promoteAttachments'],
                    'promote': payload['promote'], 'attachmentInputHash': payload['attachmentInputHash'],
                    'policyHash': payload['policyHash']}}
    mail = readonly(home / 'mail-mirror/mail.db')
    own = sorted({a.strip().lower() for r in mail.execute('SELECT emails FROM accounts')
                  for a in (r['emails'] or '').replace(';', ',').split(',') if a.strip()})
    files = collections.defaultdict(list)
    for row in mail.execute('SELECT m.thread_id,a.filename,a.mime,a.size,a.sha256,a.message_id FROM attachments a JOIN messages m ON m.message_id=a.message_id WHERE m.deleted=0'):
        if row['thread_id'] in labels:
            files[row['thread_id']].append(dict(row))
    for tid in list(labels):
        if files[tid] and labels[tid]['labelEvidence']['kind'] == 'negative_terminal_state':
            exclusions['negative_attachment_snapshot_unverified'] += 1
            del labels[tid]
    print(json.dumps({'excludedCounts': dict(exclusions)}))
    batch = []

    def emit(messages):
        tid = messages[0]['thread_id']
        if tid in labels:
            print(json.dumps({'messages': messages, 'state': labels[tid], 'attachments': files[tid], 'userAddrs': own}, ensure_ascii=True))

    for row in mail.execute('SELECT thread_id,date,subject,from_name,from_addr,to_addrs,cc_addrs,body_text FROM messages INDEXED BY idx_messages_thread WHERE deleted=0 AND thread_id IS NOT NULL ORDER BY thread_id'):
        if batch and row['thread_id'] != batch[0]['thread_id']:
            emit(batch)
            batch = []
        batch.append(dict(row))
    if batch:
        emit(batch)
    mail.close()


def period(row):
    date = dt.datetime.fromtimestamp(row['latestMessageAt'], dt.timezone.utc)
    return f'{date.year}-Q{(date.month - 1)//3 + 1}'


def representative_sample(rows, count, rng):
    """Round-robin shuffled periods so small historical periods survive sampling."""
    buckets = collections.defaultdict(list)
    for row in rows:
        buckets[period(row)].append(row)
    for bucket in buckets.values():
        rng.shuffle(bucket)
    selected = []
    while len(selected) < count and any(buckets.values()):
        for key in sorted(buckets):
            if buckets[key] and len(selected) < count:
                selected.append(buckets[key].pop())
    return selected


def finish(args):
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(args.output, 0o700)
    if (args.output / 'dataset.jsonl').exists():
        raise RuntimeError('Do not overwrite a frozen dataset; choose a new output directory.')
    old_groups = {json.loads(line)['groupHash'] for line in args.previous.read_text().splitlines()}
    excluded = collections.Counter()
    groups = collections.defaultdict(list)
    for line in sys.stdin:
        row = json.loads(line)
        if 'excludedCounts' in row:
            excluded.update(row['excludedCounts'])
        elif 'excluded' in row:
            excluded[row['excluded']] += 1
        else:
            groups[row['groupHash']].append(row)
    unique = []
    for group in groups.values():
        if len({r['label'] for r in group}) > 1:
            excluded['conflicting_template_labels'] += len(group)
            continue
        excluded['duplicate_template'] += len(group) - 1
        unique.append(max(group, key=lambda r: (r['decisionAt'], r['threadId'])))
    rng = random.Random(20261104)
    partitions = {'train': [], 'validation': [], 'test': []}
    held_groups = set()
    for label in [0, 1]:
        fresh = [r for r in unique if r['label'] == label and r['groupHash'] not in old_groups]
        # New holdouts contain no group examined in the first experiment.
        chosen = representative_sample(fresh, min(2 * args.eval_per_class, len(fresh)), rng)
        strata = collections.defaultdict(list)
        for row in chosen:
            strata[period(row)].append(row)
        for key, bucket in strata.items():
            rng.shuffle(bucket)
            for i, row in enumerate(bucket):
                # Alternate the starting side across periods to avoid always
                # assigning singleton periods to the same split.
                side = (i + int(hashlib.sha256(key.encode()).hexdigest()[:8], 16)) % 2
                partitions['validation' if side == 0 else 'test'].append(row)
                held_groups.add(row['groupHash'])
    remaining = [r for r in unique if r['groupHash'] not in held_groups]
    for label in [0, 1]:
        candidates = [r for r in remaining if r['label'] == label]
        partitions['train'].extend(representative_sample(candidates, min(args.train_per_class, len(candidates)), rng))
    selected = []
    summary = {'labels': 'Audited/inferred LLM weak labels; not human ground truth',
               'excluded': dict(excluded), 'uniqueEligibleThreads': len(unique),
               'splitPolicy': 'Template-disjoint, stratified across email quarters; all holdout groups absent from the prior experiment.',
               'evaluationSampling': 'Period and label stratified diagnostic sample; do not interpret its raw discard rate as production savings.',
               'previousDatasetSha256': hashlib.sha256(args.previous.read_bytes()).hexdigest(),
               'splits': {}, 'unseenEligibleByLabel': dict(collections.Counter(r['label'] for r in unique if r['groupHash'] not in old_groups)),
               'limitations': ['Wiki audit links by exact thread filename and decision second (plus one second for rounding).',
                              'Historical positive attachment decisions are unknown when only mail promotion is proven.',
                              'Historical negatives with current attachments are excluded because their old attachment snapshot is unavailable.',
                              'Email-period stratification is retrospective, not a test on future incoming mail.',
                              'Manual review is pending; these labels are not human truth.']}
    for split, rows in partitions.items():
        rows.sort(key=lambda r: (r['decisionAt'], r['threadId']))
        assert len({r['label'] for r in rows}) == 2, f'{split} needs both classes'
        for row in rows:
            row['split'] = split
        selected.extend(rows)
        summary['splits'][split] = {'selected': dict(collections.Counter(r['label'] for r in rows)),
            'emailPeriods': dict(sorted(collections.Counter(period(r) for r in rows).items())),
            'decisionDays': dict(sorted(collections.Counter(dt.datetime.fromtimestamp(r['decisionAt'], dt.timezone.utc).strftime('%Y-%m-%d') for r in rows).items())),
            'evidence': dict(collections.Counter(r['labelEvidence']['kind'] for r in rows))}
    path = args.output / 'dataset.jsonl'
    with path.open('w') as stream:
        os.chmod(path, 0o600)
        for row in selected:
            stream.write(json.dumps(row, ensure_ascii=True) + '\n')
    summary['datasetSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    (args.output / 'dataset-summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['export', 'finish'])
    parser.add_argument('--output', type=Path, default=Path('.local-evals/mail-detection-v2'))
    parser.add_argument('--previous', type=Path, default=Path('.local-evals/mail-detection/dataset.jsonl'))
    parser.add_argument('--train-per-class', type=int, default=2000)
    parser.add_argument('--eval-per-class', type=int, default=750)
    args = parser.parse_args()
    export() if args.command == 'export' else finish(args)
